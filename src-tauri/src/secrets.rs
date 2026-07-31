use keyring::Entry;
use uuid::Uuid;

const SERVICE: &str = "com.admin.protunel";

/// Store a tunnel's secret (password or key passphrase) in the OS credential vault.
/// Never persisted in the SQLite database.
pub fn set_secret(tunnel_id: Uuid, secret: &str) -> keyring::Result<()> {
    let entry = Entry::new(SERVICE, &tunnel_id.to_string())?;
    entry.set_password(secret)
}

pub fn get_secret(tunnel_id: Uuid) -> keyring::Result<Option<String>> {
    let entry = Entry::new(SERVICE, &tunnel_id.to_string())?;
    match entry.get_password() {
        Ok(pw) => Ok(Some(pw)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn delete_secret(tunnel_id: Uuid) -> keyring::Result<()> {
    let entry = Entry::new(SERVICE, &tunnel_id.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e),
    }
}
