use std::collections::VecDeque;
use std::time::Duration;

use russh_sftp::{client::SftpSession, protocol::{FileAttributes, OpenFlags}};
use serde::Serialize;

use super::{at, err, exec, is_missing, join, quote, split, stderr_or, stem_ext, Handle};

/// Delete counts stop here; the confirmation then says "more than".
pub const COUNT_LIMIT: u64 = 100_000;

/// A new empty file; fails if the name is taken.
pub async fn create_file(sftp: &SftpSession, path: &str) -> Result<(), String> {
    let file = sftp
        .open_with_flags(path, OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE)
        .await
        .map_err(err)?;
    file.close().await.map_err(|e| e.to_string())
}

pub async fn create_dir(sftp: &SftpSession, path: &str) -> Result<(), String> {
    if exists(sftp, path).await? {
        return Err("exists".to_string());
    }
    sftp.create_dir(path).await.map_err(err)
}

/// Renames or moves; never replaces an existing target.
pub async fn rename(sftp: &SftpSession, from: &str, to: &str) -> Result<(), String> {
    if exists(sftp, to).await? {
        return Err("exists".to_string());
    }
    sftp.rename(from, to).await.map_err(err)
}

pub async fn exists(sftp: &SftpSession, path: &str) -> Result<bool, String> {
    match sftp.symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(e) if is_missing(&e) => Ok(false),
        Err(e) => Err(err(e)),
    }
}

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Count {
    pub files: u64,
    pub dirs: u64,
    /// The walk stopped at `COUNT_LIMIT`.
    pub more: bool,
}

/// What deleting `paths` would remove. Symlinks count as files and are never
/// followed.
pub async fn count(sftp: &SftpSession, paths: &[String]) -> Result<Count, String> {
    let mut count = Count::default();
    let mut queue: VecDeque<String> = VecDeque::new();
    for path in paths {
        let attrs = sftp.symlink_metadata(path.as_str()).await.map_err(err)?;
        if attrs.is_dir() {
            count.dirs += 1;
            queue.push_back(path.clone());
        } else {
            count.files += 1;
        }
    }
    while let Some(dir) = queue.pop_front() {
        for item in sftp.read_dir(&dir).await.map_err(err)? {
            if count.files + count.dirs >= COUNT_LIMIT {
                count.more = true;
                return Ok(count);
            }
            if item.metadata().is_dir() && !item.metadata().is_symlink() {
                count.dirs += 1;
                queue.push_back(item.path());
            } else {
                count.files += 1;
            }
        }
    }
    Ok(count)
}

/// Deletes files and whole folders (depth first). Symlinks are removed, never
/// followed. Stops at the first error, which names the path.
pub async fn delete(sftp: &SftpSession, paths: &[String]) -> Result<(), String> {
    for path in paths {
        let attrs = sftp.symlink_metadata(path.as_str()).await.map_err(err)?;
        if attrs.is_dir() && !attrs.is_symlink() {
            delete_tree(sftp, path, false).await?;
        } else {
            sftp.remove_file(path.as_str()).await.map_err(|e| at(path, e))?;
        }
    }
    Ok(())
}

pub(super) async fn delete_tree(sftp: &SftpSession, root: &str, staged_copy: bool) -> Result<(), String> {
    // Iterative post-order: a deep tree must not grow the async stack.
    let mut stack = vec![(root.to_string(), false)];
    while let Some((dir, emptied)) = stack.pop() {
        if emptied {
            sftp.remove_dir(dir.as_str()).await.map_err(|e| at(&dir, e))?;
            continue;
        }
        // Checked again right before reading: a folder swapped for a symlink
        // since it was listed must not lead the walk somewhere else.
        let now = sftp.symlink_metadata(dir.as_str()).await.map_err(|e| at(&dir, e))?;
        if now.is_symlink() || !now.is_dir() {
            return Err(format!("{dir}: changed while deleting"));
        }
        if staged_copy {
            make_stage_writable(sftp, &dir, &now).await?;
        }
        stack.push((dir.clone(), true));
        for item in sftp.read_dir(&dir).await.map_err(|e| at(&dir, e))? {
            let meta = item.metadata();
            if meta.is_dir() && !meta.is_symlink() {
                stack.push((item.path(), false));
            } else {
                let path = item.path();
                sftp.remove_file(path.as_str()).await.map_err(|e| at(&path, e))?;
            }
        }
    }
    Ok(())
}

/// SCP preserves directory modes, including read-only ones, in its staging
/// tree. Moving or removing staged children requires write access to the parent.
async fn make_stage_writable(sftp: &SftpSession, path: &str, attrs: &FileAttributes) -> Result<(), String> {
    if let Some(mode) = attrs.permissions.filter(|mode| mode & 0o700 != 0o700) {
        let attrs = FileAttributes { permissions: Some((mode & 0o7777) | 0o700), ..FileAttributes::empty() };
        sftp.set_metadata(path, attrs).await.map_err(|e| at(path, e))?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasteOutcome {
    /// Final paths of what was pasted.
    pub done: Vec<String>,
    /// Sources skipped because the name is taken in the destination.
    pub skipped: Vec<String>,
}

/// Pastes `sources` into `dest_dir`. Cut is an SFTP rename; copy is the
/// server's `cp -a` (SFTP has no copy). Pasting a copy into its own folder
/// makes "name (copy)"; any other name clash is skipped, never overwritten.
pub async fn paste(
    session: &Handle,
    sftp: &SftpSession,
    sources: &[String],
    dest_dir: &str,
    cut: bool,
) -> Result<PasteOutcome, String> {
    let mut outcome = PasteOutcome { done: Vec::new(), skipped: Vec::new() };
    for source in sources {
        let (parent, name) = split(source);
        let same_dir = parent.trim_end_matches('/') == dest_dir.trim_end_matches('/');
        let mut target = join(dest_dir, name);
        if cut && same_dir {
            continue;
        }
        if exists(sftp, &target).await? {
            if cut || !same_dir {
                outcome.skipped.push(source.clone());
                continue;
            }
            target = free_name(sftp, dest_dir, name).await?;
        }
        if cut {
            sftp.rename(source.as_str(), target.as_str()).await.map_err(|e| at(source, e))?;
        } else {
            // -n: a file that appeared there since the check is never replaced.
            let cmd = format!("cp -a -n -- {} {}", quote(source), quote(&target));
            let out = exec(session, &cmd, Duration::from_secs(600)).await?;
            if out.status != Some(0) {
                return Err(format!("{source}: {}", stderr_or(&out, "cp failed")));
            }
        }
        outcome.done.push(target);
    }
    Ok(outcome)
}

/// "name (copy).ext", "name (copy 2).ext"… whichever is free in `dir`.
async fn free_name(sftp: &SftpSession, dir: &str, name: &str) -> Result<String, String> {
    let (stem, ext) = stem_ext(name);
    for n in 1..1000 {
        let label = if n == 1 { "copy".to_string() } else { format!("copy {n}") };
        let candidate = join(dir, &format!("{stem} ({label}){ext}"));
        if !exists(sftp, &candidate).await? {
            return Ok(candidate);
        }
    }
    Err("exists".to_string())
}
