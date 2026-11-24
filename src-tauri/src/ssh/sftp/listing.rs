use std::time::Duration;

use russh_sftp::{client::SftpSession, protocol::FileAttributes};
use serde::Serialize;

use super::{err, exec, join, quote, split, stderr_or, Handle};

#[derive(Clone, Copy, Serialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Dir,
    File,
    Symlink,
    Other,
}

#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: Kind,
    /// For a symlink: whether it points at a directory (it opens like one).
    pub link_dir: bool,
    pub size: u64,
    pub mtime: Option<u32>,
    /// Permission bits only (no file type), e.g. 0o644.
    pub mode: Option<u32>,
    pub uid: Option<u32>,
    pub gid: Option<u32>,
}

fn kind_of(attrs: &FileAttributes) -> Kind {
    if attrs.is_symlink() {
        Kind::Symlink
    } else if attrs.is_dir() {
        Kind::Dir
    } else if attrs.is_regular() {
        Kind::File
    } else {
        Kind::Other
    }
}

fn entry(name: String, attrs: &FileAttributes) -> Entry {
    Entry {
        name,
        kind: kind_of(attrs),
        link_dir: false,
        size: attrs.size.unwrap_or(0),
        mtime: attrs.mtime,
        mode: attrs.permissions.map(|p| p & 0o7777),
        uid: attrs.uid,
        gid: attrs.gid,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// The directory, canonical (symlinks and `..` resolved).
    pub path: String,
    pub entries: Vec<Entry>,
}

pub async fn list(sftp: &SftpSession, path: &str) -> Result<Listing, String> {
    let path = sftp.canonicalize(path).await.map_err(err)?;
    let dir = sftp.read_dir(&path).await.map_err(err)?;
    let mut entries = Vec::new();
    for item in dir {
        let attrs = item.metadata();
        let mut e = entry(item.file_name(), &attrs);
        if e.kind == Kind::Symlink {
            // One stat per link, so a link to a folder opens as one.
            if let Ok(target) = sftp.metadata(join(&path, &e.name)).await {
                e.link_dir = target.is_dir();
            }
        }
        entries.push(e);
    }
    Ok(Listing { path, entries })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Properties {
    pub path: String,
    #[serde(flatten)]
    pub entry: Entry,
    pub owner: Option<String>,
    pub group: Option<String>,
    pub link_target: Option<String>,
    pub atime: Option<u32>,
}

pub async fn properties(
    session: &Handle,
    sftp: &SftpSession,
    path: &str,
) -> Result<Properties, String> {
    let attrs = sftp.symlink_metadata(path).await.map_err(err)?;
    let (_, name) = split(path);
    let mut e = entry(name.to_string(), &attrs);
    let mut link_target = None;
    if e.kind == Kind::Symlink {
        link_target = sftp.read_link(path).await.ok();
        e.link_dir = sftp.metadata(path).await.is_ok_and(|a| a.is_dir());
    }
    // SFTP v3 only carries ids; names come from the server's own tables.
    let (owner, group) = match (attrs.uid, attrs.gid) {
        (Some(uid), Some(gid)) => names(session, uid, gid).await,
        _ => (None, None),
    };
    Ok(Properties { path: path.to_string(), entry: e, owner, group, link_target, atime: attrs.atime })
}

async fn names(session: &Handle, uid: u32, gid: u32) -> (Option<String>, Option<String>) {
    let cmd = format!("getent passwd {uid} | cut -d: -f1; getent group {gid} | cut -d: -f1");
    let Ok(out) = exec(session, &cmd, Duration::from_secs(5)).await else {
        return (None, None);
    };
    let mut lines = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .collect::<Vec<_>>()
        .into_iter();
    let pick = |s: Option<String>| s.filter(|s| !s.is_empty());
    (pick(lines.next()), pick(lines.next()))
}

/// Total size of a folder, from the server's `du` (one round trip instead of a
/// walk over SFTP). In bytes; `du -sk` because busybox has no `-b`.
pub async fn dir_size(session: &Handle, path: &str) -> Result<u64, String> {
    let out = exec(session, &format!("du -sk -- {}", quote(path)), Duration::from_secs(60)).await?;
    let text = String::from_utf8_lossy(&out.stdout);
    let kib: u64 = text
        .split_whitespace()
        .next()
        .and_then(|n| n.parse().ok())
        .ok_or_else(|| stderr_or(&out, "du failed"))?;
    Ok(kib * 1024)
}
