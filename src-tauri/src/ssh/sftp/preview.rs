use russh_sftp::{client::SftpSession, protocol::{FileAttributes, OpenFlags}};
use serde::Serialize;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use uuid::Uuid;

use super::{err, join, split};

/// A fingerprint of a file's bytes: catches a change that kept size and
/// mtime (SFTP v3 mtime has one-second resolution). A string: u64 does not
/// survive a JS number.
pub fn fingerprint(data: &[u8]) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    data.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Largest text file shown or edited in the popup.
pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
/// Largest image previewed in the popup.
pub const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// "Last part" of a log too big to show whole.
const TAIL_BYTES: u64 = 1024 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum Content {
    Text {
        text: String,
        size: u64,
        mtime: Option<u32>,
        /// Only the last `TAIL_BYTES` were read.
        tail: bool,
        /// `fingerprint` of the whole file; none for a tail.
        hash: Option<String>,
        /// Not valid UTF-8 (some bytes shown as U+FFFD): read-only, since
        /// saving would write the replacements over the original bytes.
        lossy: bool,
    },
    Binary { size: u64 },
    TooLarge { size: u64 },
}

/// A text file for the viewer/editor. `tail` reads only the last part of a
/// file over the limit (logs).
pub async fn read_text(sftp: &SftpSession, path: &str, tail: bool) -> Result<Content, String> {
    let attrs = sftp.metadata(path).await.map_err(err)?;
    let size = attrs.size.unwrap_or(0);
    if size > MAX_TEXT_BYTES && !tail {
        return Ok(Content::TooLarge { size });
    }
    let mut file = sftp.open(path).await.map_err(err)?;
    let from = if size > MAX_TEXT_BYTES { size - TAIL_BYTES } else { 0 };
    if from > 0 {
        file.seek(std::io::SeekFrom::Start(from)).await.map_err(|e| e.to_string())?;
    }
    let mut buf = Vec::with_capacity((size - from) as usize);
    (&mut file)
        .take(MAX_TEXT_BYTES)
        .read_to_end(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    let _ = file.close().await;
    if looks_binary(&buf) {
        return Ok(Content::Binary { size });
    }
    // A tail starts mid-line (maybe mid-character) and loses that line
    // below: only what is shown has to be valid.
    let shown = match buf.iter().position(|&b| b == b'\n') {
        Some(i) if from > 0 => &buf[i + 1..],
        _ => &buf[..],
    };
    let lossy = std::str::from_utf8(shown).is_err();
    let mut text = String::from_utf8_lossy(&buf).into_owned();
    if from > 0 {
        // Starts mid-line: drop the partial first line.
        if let Some(i) = text.find('\n') {
            text.drain(..=i);
        }
    }
    let hash = (from == 0).then(|| fingerprint(&buf));
    Ok(Content::Text { text, size, mtime: attrs.mtime, tail: from > 0, hash, lossy })
}

/// NUL bytes, or mostly invalid UTF-8, in the first 8 KiB.
pub fn looks_binary(buf: &[u8]) -> bool {
    let head = &buf[..buf.len().min(8192)];
    if head.contains(&0) {
        return true;
    }
    let bad = String::from_utf8_lossy(head).matches('\u{FFFD}').count();
    bad * 20 > head.len().max(1)
}

/// Raw bytes of a small file (image preview).
pub async fn read_bytes(sftp: &SftpSession, path: &str) -> Result<Vec<u8>, String> {
    let attrs = sftp.metadata(path).await.map_err(err)?;
    if attrs.size.unwrap_or(0) > MAX_IMAGE_BYTES {
        return Err("too-large".to_string());
    }
    let mut file = sftp.open(path).await.map_err(err)?;
    let mut buf = Vec::new();
    (&mut file)
        .take(MAX_IMAGE_BYTES + 1)
        .read_to_end(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    let _ = file.close().await;
    if buf.len() as u64 > MAX_IMAGE_BYTES {
        return Err("too-large".to_string());
    }
    Ok(buf)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub size: u64,
    pub mtime: Option<u32>,
    pub hash: Option<String>,
}

/// What the editor last read or saved: a save refuses with "conflict" when
/// the file no longer matches it.
pub struct Expect {
    pub size: u64,
    pub mtime: Option<u32>,
    pub hash: Option<String>,
}

/// Size and mtime first (cheap); then the bytes, when the editor has a hash.
async fn unchanged(sftp: &SftpSession, path: &str, expect: &Expect) -> Result<bool, String> {
    let now = match sftp.metadata(path).await {
        Ok(now) => now,
        Err(_) => return Ok(false),
    };
    if now.size.unwrap_or(0) != expect.size || now.mtime != expect.mtime {
        return Ok(false);
    }
    let Some(hash) = &expect.hash else { return Ok(true) };
    if expect.size > MAX_TEXT_BYTES {
        return Ok(true);
    }
    let mut file = sftp.open(path).await.map_err(err)?;
    let mut buf = Vec::with_capacity(expect.size as usize);
    (&mut file)
        .take(MAX_TEXT_BYTES + 1)
        .read_to_end(&mut buf)
        .await
        .map_err(|e| e.to_string())?;
    let _ = file.close().await;
    Ok(&fingerprint(&buf) == hash)
}

/// Saves edited text. Refuses with "conflict" when the file changed since it
/// was opened (size, mtime or bytes), unless `force`. The caller serializes
/// saves of one file (`commands::files`), so two editors in this app can't
/// both pass the check before either lands.
///
/// Safe write: a temp file next to the original (for a symlink, next to the
/// file it points to, so the link survives), given the original's mode,
/// owner and group, then renamed over it (posix-rename) so a dropped
/// connection never leaves a half-written file. When that cannot keep the
/// file as it was (an owner we can't set, no posix-rename, no write access to
/// the folder) it refuses with "unsafe-save" unless `in_place`: writing in
/// place keeps inode, owner and links, but a dropped connection can leave
/// the file cut short, so the user decides.
pub async fn write_text(
    sftp: &SftpSession,
    path: &str,
    text: &str,
    expect: &Expect,
    force: bool,
    in_place: bool,
) -> Result<Saved, String> {
    let link = sftp.symlink_metadata(path).await.map_err(err)?;
    let current = sftp.metadata(path).await.map_err(err)?;
    if !force && !unchanged(sftp, path, expect).await? {
        return Err("conflict".to_string());
    }
    let real = if link.is_symlink() {
        sftp.canonicalize(path).await.map_err(err)?
    } else {
        path.to_string()
    };
    let data = text.as_bytes();
    // Forced: still never over a change made while the temp file was written.
    let fresh = Expect { size: current.size.unwrap_or(0), mtime: current.mtime, hash: None };
    let check = if force { &fresh } else { expect };
    let replaced = if in_place {
        Staged::Unsuitable
    } else {
        replace_atomically(sftp, &real, data, &current, check).await
    };
    match replaced {
        Staged::Failed(e) => return Err(e), // the original is untouched
        Staged::Unsuitable if !in_place => return Err("unsafe-save".to_string()),
        Staged::Unsuitable => {
            if !unchanged(sftp, path, check).await? {
                return Err("conflict".to_string());
            }
            let mut file = sftp
                .open_with_flags(path, OpenFlags::WRITE | OpenFlags::TRUNCATE)
                .await
                .map_err(err)?;
            file.write_all(data).await.map_err(|e| e.to_string())?;
            file.shutdown().await.map_err(|e| e.to_string())?;
        }
        Staged::Replaced => {}
    }
    let after = sftp.metadata(path).await.map_err(err)?;
    Ok(Saved { size: after.size.unwrap_or(0), mtime: after.mtime, hash: Some(fingerprint(data)) })
}

enum Staged {
    Replaced,
    /// Can't keep the file as it was this way: write in place instead.
    Unsuitable,
    Failed(String),
}

/// The temp-and-rename half of `write_text`; cleans up whatever it backs out of.
async fn replace_atomically(
    sftp: &SftpSession,
    path: &str,
    data: &[u8],
    original: &FileAttributes,
    expect: &Expect,
) -> Staged {
    let (dir, name) = split(path);
    let temp = join(dir, &format!(".{name}.protunel-{}", &Uuid::new_v4().simple().to_string()[..8]));
    let Ok(mut file) = super::create_private(sftp, &temp).await else {
        return Staged::Unsuitable; // no write access to the folder
    };
    let written = match file.write_all(data).await {
        Ok(()) => file.shutdown().await,
        Err(e) => Err(e),
    };
    drop(file);
    if let Err(e) = written {
        let _ = sftp.remove_file(&temp).await;
        return Staged::Failed(e.to_string());
    }
    let keep = FileAttributes {
        permissions: original.permissions.map(|p| p & 0o7777),
        uid: original.uid,
        gid: original.gid,
        ..FileAttributes::empty()
    };
    let _ = sftp.set_metadata(&temp, keep).await;
    let same = match sftp.metadata(&temp).await {
        Ok(t) => {
            t.uid == original.uid
                && t.gid == original.gid
                && t.permissions.map(|p| p & 0o7777) == original.permissions.map(|p| p & 0o7777)
        }
        Err(_) => false,
    };
    if !same {
        let _ = sftp.remove_file(&temp).await;
        return Staged::Unsuitable;
    }
    // Last look right before the swap (SFTP has no compare-and-swap).
    if !matches!(unchanged(sftp, path, expect).await, Ok(true)) {
        let _ = sftp.remove_file(&temp).await;
        return Staged::Failed("conflict".to_string());
    }
    match sftp.posix_rename(&temp, path).await {
        Ok(true) => Staged::Replaced,
        Ok(false) => {
            let _ = sftp.remove_file(&temp).await;
            Staged::Unsuitable
        }
        Err(e) => {
            let _ = sftp.remove_file(&temp).await;
            Staged::Failed(err(e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn binary_detection() {
        assert!(!looks_binary(b"hello\nworld\n"));
        assert!(!looks_binary("xin chào".as_bytes()));
        assert!(looks_binary(b"\x7fELF\x02\x01\x01\x00\x00"));
        assert!(looks_binary(&[0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa]));
    }
}
