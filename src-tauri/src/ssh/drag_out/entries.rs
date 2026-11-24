use std::collections::HashMap;

use russh_sftp::{client::SftpSession, protocol::FileAttributes};
use tokio_util::sync::CancellationToken;
use windows::Win32::{
    Foundation::FILETIME,
    Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL},
    UI::Shell::{FD_ATTRIBUTES, FD_FILESIZE, FD_PROGRESSUI, FD_UNICODE, FD_WRITESTIME, FILEDESCRIPTORW},
};

use super::sftp;

const ENTRY_LIMIT: usize = 20_000;

pub(super) struct Entry {
    pub(super) remote: String,
    pub(super) relative: String,
    pub(super) directory: bool,
    pub(super) size: u64,
    pub(super) mtime: Option<u32>,
}

/// Allocate a Windows-safe component among the files and folders of one parent.
fn unique_name(name: &str, used: &mut HashMap<String, u32>) -> String {
    let sanitized = sftp::sanitize(name);
    let mut name = sanitized.trim_end_matches(['.', ' ']).to_owned();
    if name.is_empty() {
        name.push('_');
    }
    let device_end = name.find('.').unwrap_or(name.len());
    let device = name[..device_end]
        .trim_end_matches(' ')
        .to_ascii_uppercase();
    if matches!(
        device.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || device
        .strip_prefix("COM")
        .or_else(|| device.strip_prefix("LPT"))
        .is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
    {
        name.insert(device_end, '_');
    }

    let key = name.to_uppercase();
    if let std::collections::hash_map::Entry::Vacant(slot) = used.entry(key.clone()) {
        slot.insert(1);
        return name;
    }
    let (stem, ext) = sftp::stem_ext(&name);
    let mut number = used[&key];
    loop {
        let candidate = format!("{stem} ({number}){ext}");
        number += 1;
        if let std::collections::hash_map::Entry::Vacant(slot) =
            used.entry(candidate.to_uppercase())
        {
            slot.insert(1);
            used.insert(key, number);
            return candidate;
        }
    }
}

fn descriptor_name(relative: &str) -> Result<[u16; 260], String> {
    let mut name = [0; 260];
    for (i, unit) in relative.encode_utf16().enumerate() {
        if i == name.len() - 1 {
            return Err(format!("path-too-long:{relative}"));
        }
        name[i] = unit;
    }
    Ok(name)
}

fn filetime(unix_seconds: u32) -> FILETIME {
    let ticks = (u64::from(unix_seconds) + 11_644_473_600) * 10_000_000;
    FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    }
}

pub(super) fn descriptor(entry: &Entry) -> Result<FILEDESCRIPTORW, String> {
    Ok(FILEDESCRIPTORW {
        dwFlags: (FD_ATTRIBUTES.0
            | FD_FILESIZE.0
            | FD_WRITESTIME.0
            | FD_PROGRESSUI.0
            | FD_UNICODE.0) as u32,
        dwFileAttributes: if entry.directory {
            FILE_ATTRIBUTE_DIRECTORY.0
        } else {
            FILE_ATTRIBUTE_NORMAL.0
        },
        ftLastWriteTime: entry.mtime.map(filetime).unwrap_or_default(),
        nFileSizeHigh: (entry.size >> 32) as u32,
        nFileSizeLow: entry.size as u32,
        cFileName: descriptor_name(&entry.relative)?,
        ..Default::default()
    })
}

/// Appending before visiting makes the descriptor order a breadth-first walk.
#[derive(Default)]
struct Entries {
    all: Vec<Entry>,
    next: usize,
}

impl Entries {
    fn push(
        &mut self,
        remote: String,
        parent: &str,
        used: &mut HashMap<String, u32>,
        attrs: FileAttributes,
    ) -> Result<(), String> {
        let directory = attrs.is_dir();
        if !directory && !attrs.is_regular() {
            return Ok(());
        }
        if self.all.len() == ENTRY_LIMIT {
            return Err("too-many".into());
        }
        let name = unique_name(sftp::split(&remote).1, used);
        let relative = if parent.is_empty() {
            name
        } else {
            format!("{parent}\\{name}")
        };
        descriptor_name(&relative)?;
        let size = if directory {
            0
        } else {
            attrs
                .size
                .ok_or_else(|| format!("{remote}: SFTP did not report the file size"))?
        };
        self.all.push(Entry {
            remote,
            relative,
            directory,
            size,
            mtime: attrs.mtime,
        });
        Ok(())
    }

    fn next_directory(&mut self) -> Option<(String, String)> {
        while let Some(entry) = self.all.get(self.next) {
            self.next += 1;
            if entry.directory {
                return Some((entry.remote.clone(), entry.relative.clone()));
            }
        }
        None
    }
}

pub(super) async fn enumerate(
    sftp: &SftpSession,
    paths: Vec<String>,
    released: &CancellationToken,
) -> Result<Vec<Entry>, String> {
    let mut entries = Entries::default();
    let mut roots = HashMap::new();
    for path in paths {
        if released.is_cancelled() {
            return Ok(Vec::new());
        }
        // A trailing slash would make LSTAT dereference a directory symlink.
        let path = if path == "/" {
            path.as_str()
        } else {
            path.trim_end_matches('/')
        };
        let attrs = sftp.symlink_metadata(path).await.map_err(sftp::err)?;
        entries.push(path.into(), "", &mut roots, attrs)?;
    }
    while let Some((remote, relative)) = entries.next_directory() {
        let mut children = HashMap::new();
        if released.is_cancelled() {
            return Ok(Vec::new());
        }
        for child in sftp.read_dir(&remote).await.map_err(sftp::err)? {
            if released.is_cancelled() {
                return Ok(Vec::new());
            }
            let name = child.file_name();
            let name = name.as_str();
            // A directory entry must address a single child of the listed folder.
            if matches!(name, "" | "." | "..") || name.contains(['/', '\0']) {
                continue;
            }
            let path = sftp::join(&remote, name);
            entries.push(path, &relative, &mut children, child.metadata())?;
        }
    }
    Ok(entries.all)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::mem::offset_of;
    use windows::Win32::UI::Shell::FILEGROUPDESCRIPTORW;

    #[test]
    fn win_checks_utf16_units_and_keeps_the_terminator() {
        let fits = format!("a{}", "😀".repeat(129));
        assert_eq!(descriptor_name(&fits).unwrap()[259], 0);
        let long = format!(r"parent\{}", "😀".repeat(127));
        assert_eq!(descriptor_name(&long), Err(format!("path-too-long:{long}")));
    }

    #[test]
    fn win_describes_files_and_directories_with_the_shell_layout() {
        let mut entry = Entry {
            remote: "/tree/file".into(),
            relative: r"tree\file".into(),
            directory: false,
            size: (5 << 32) | 42,
            mtime: Some(1),
        };
        let file = descriptor(&entry).unwrap();
        assert_eq!((file.nFileSizeHigh, file.nFileSizeLow), (5, 42));
        assert_eq!({ file.cFileName }, descriptor_name(r"tree\file").unwrap());
        assert_eq!(
            { file.dwFlags },
            (FD_ATTRIBUTES.0 | FD_FILESIZE.0 | FD_WRITESTIME.0 | FD_PROGRESSUI.0 | FD_UNICODE.0)
                as u32
        );
        assert_eq!({ file.dwFileAttributes }, FILE_ATTRIBUTE_NORMAL.0);
        assert_eq!({ file.ftLastWriteTime }, filetime(1));
        entry.directory = true;
        assert_eq!(
            { descriptor(&entry).unwrap().dwFileAttributes },
            FILE_ATTRIBUTE_DIRECTORY.0
        );
        assert_eq!(offset_of!(FILEGROUPDESCRIPTORW, fgd), 4);
    }

    #[test]
    fn win_converts_unix_seconds_to_windows_ticks() {
        let ticks =
            |time: FILETIME| u64::from(time.dwHighDateTime) << 32 | u64::from(time.dwLowDateTime);
        assert_eq!(ticks(filetime(0)), 116_444_736_000_000_000);
        assert_eq!(ticks(filetime(1)) - ticks(filetime(0)), 10_000_000);
        assert_eq!(ticks(filetime(u32::MAX)), 159_394_408_950_000_000);
    }

    #[test]
    fn win_allocates_safe_names_and_resolves_case_insensitive_collisions() {
        let mut used = HashMap::new();
        for (name, expected) in [
            ("CON", "CON_"),
            ("con.TXT ", "con_.TXT"),
            ("Con_.txt.", "Con_ (1).txt"),
            ("prn.tar.gz", "prn_.tar.gz"),
            ("aux.ext", "aux_.ext"),
            ("NUL. ", "NUL_"),
            ("COM9", "COM9_"),
            ("Lpt1.log", "Lpt1_.log"),
            ("COM0", "COM0"),
            ("LPT10", "LPT10"),
            (" ... ", "_"),
            ("a?b.TXT", "a_b.TXT"),
            ("a_b (1).txt", "a_b (1).txt"),
            ("A:B.txt", "A_B (2).txt"),
            ("a*b.TXT", "a_b (3).TXT"),
        ] {
            assert_eq!(unique_name(name, &mut used), expected);
        }
    }

    #[test]
    fn win_enumerates_parents_first_and_skips_non_regular_entries() {
        let dir = FileAttributes {
            permissions: Some(0o040755),
            ..Default::default()
        };
        let file = FileAttributes {
            permissions: Some(0o100644),
            size: Some(7),
            ..Default::default()
        };
        let link = FileAttributes {
            permissions: Some(0o120777),
            ..Default::default()
        };
        let socket = FileAttributes {
            permissions: Some(0o140777),
            ..Default::default()
        };
        let mut entries = Entries::default();
        let mut roots = HashMap::new();
        entries
            .push("/a".into(), "", &mut roots, file.clone())
            .unwrap();
        entries
            .push("/A".into(), "", &mut roots, dir.clone())
            .unwrap();
        let (parent, relative) = entries.next_directory().unwrap();
        assert_eq!(parent, "/A");
        let mut children = HashMap::new();
        entries
            .push("/A/CON.".into(), &relative, &mut children, dir)
            .unwrap();
        entries
            .push("/A/link".into(), &relative, &mut children, link)
            .unwrap();
        entries
            .push("/A/socket".into(), &relative, &mut children, socket)
            .unwrap();
        entries
            .push("/A/a".into(), &relative, &mut children, file.clone())
            .unwrap();
        entries
            .push("/A/A".into(), &relative, &mut children, file.clone())
            .unwrap();
        let (parent, relative) = entries.next_directory().unwrap();
        assert_eq!(parent, "/A/CON.");
        entries
            .push("/A/CON./a".into(), &relative, &mut HashMap::new(), file)
            .unwrap();
        assert!(entries.next_directory().is_none());
        let paths: Vec<&str> = entries.all.iter().map(|e| e.relative.as_str()).collect();
        assert_eq!(
            paths,
            [
                "a",
                "A (1)",
                r"A (1)\CON_",
                r"A (1)\a",
                r"A (1)\A (1)",
                r"A (1)\CON_\a"
            ]
        );
    }

    #[test]
    fn win_rejects_entry_twenty_thousand_and_one() {
        let file = FileAttributes {
            permissions: Some(0o100644),
            size: Some(0),
            ..Default::default()
        };
        let mut entries = Entries::default();
        let mut roots = HashMap::new();
        for _ in 0..ENTRY_LIMIT {
            entries
                .push("/file".into(), "", &mut roots, file.clone())
                .unwrap();
        }
        assert_eq!(
            entries.push("/extra".into(), "", &mut roots, file),
            Err("too-many".into())
        );
    }
}
