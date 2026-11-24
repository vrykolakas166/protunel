/// `/a/b` + `c` → `/a/b/c`.
pub fn join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{dir}{name}")
    } else {
        format!("{dir}/{name}")
    }
}

/// The parent directory and file name of a remote path.
pub fn split(path: &str) -> (&str, &str) {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => ("/", &trimmed[1..]),
        Some(i) => (&trimmed[..i], &trimmed[i + 1..]),
        None => (".", trimmed),
    }
}

/// Splits "a.tar.gz" as ("a.tar", ".gz"); dotfiles keep their name as the stem.
pub fn stem_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}

/// POSIX single-quoting: safe for any byte but NUL, in sh, bash, zsh and fish.
pub fn quote(arg: &str) -> String {
    format!("'{}'", arg.replace('\'', r"'\''"))
}

/// A remote name made safe as a local file name (Windows forbids `\:*?"<>|`).
pub fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    match cleaned.as_str() {
        "" | "." | ".." => "_".to_string(),
        _ => cleaned,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_split_and_join() {
        assert_eq!(split("/var/log/x.log"), ("/var/log", "x.log"));
        assert_eq!(split("/etc"), ("/", "etc"));
        assert_eq!(split("/etc/"), ("/", "etc"));
        assert_eq!(split("rel"), (".", "rel"));
        assert_eq!(join("/", "etc"), "/etc");
        assert_eq!(join("/var", "log"), "/var/log");
    }

    #[test]
    fn quoting_survives_any_name() {
        assert_eq!(quote("a b"), "'a b'");
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert_eq!(quote("$(rm -rf /)"), "'$(rm -rf /)'");
        assert_eq!(quote("-rf"), "'-rf'");
    }

    #[test]
    fn copy_names_and_local_names() {
        assert_eq!(stem_ext("a.tar.gz"), ("a.tar", ".gz"));
        assert_eq!(stem_ext(".env"), (".env", ""));
        assert_eq!(stem_ext("Makefile"), ("Makefile", ""));
        assert_eq!(sanitize("a:b?.txt"), "a_b_.txt");
        assert_eq!(sanitize(".."), "_");
    }
}
