use keyring::Entry;
use uuid::Uuid;

const SERVICE: &str = "com.admin.protunel";

#[cfg(test)]
pub(crate) static TEST_SECRETS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::HashMap<Uuid, Option<String>>>,
> = std::sync::LazyLock::new(Default::default);

/// Store a tunnel's secret (password or key passphrase) in the OS credential vault.
/// Never persisted in the SQLite database.
pub fn set_secret(tunnel_id: Uuid, secret: &str) -> keyring::Result<()> {
    Vault(SERVICE).set(tunnel_id, secret)
}

pub fn get_secret(tunnel_id: Uuid) -> keyring::Result<Option<String>> {
    #[cfg(test)]
    if let Some(secret) = TEST_SECRETS.lock().unwrap().get(&tunnel_id).cloned() {
        return Ok(secret);
    }
    Vault(SERVICE).get(tunnel_id)
}

pub fn delete_secret(tunnel_id: Uuid) -> keyring::Result<()> {
    Vault(SERVICE).delete(tunnel_id)
}

struct Vault<'a>(&'a str);

impl Vault<'_> {
    fn entry(&self, tunnel_id: Uuid) -> keyring::Result<Entry> {
        Entry::new(self.0, &tunnel_id.to_string())
    }

    fn set(&self, tunnel_id: Uuid, secret: &str) -> keyring::Result<()> {
        self.entry(tunnel_id)?.set_password(secret)
    }

    fn get(&self, tunnel_id: Uuid) -> keyring::Result<Option<String>> {
        match self.entry(tunnel_id)?.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e),
        }
    }

    fn delete(&self, tunnel_id: Uuid) -> keyring::Result<()> {
        match self.entry(tunnel_id)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    struct CredentialCleanup(Entry);

    impl Drop for CredentialCleanup {
        fn drop(&mut self) {
            let _ = self.0.delete_credential();
        }
    }

    #[test]
    fn win_credential_manager_round_trip_and_target_name() {
        let service = format!("protunel-test-{}", Uuid::new_v4());
        let tunnel_id = Uuid::new_v4();
        let vault = Vault(&service);
        let credential = CredentialCleanup(vault.entry(tunnel_id).unwrap());

        assert_eq!(vault.get(tunnel_id).unwrap(), None);
        vault.set(tunnel_id, "first password").unwrap();
        assert_eq!(
            vault.get(tunnel_id).unwrap().as_deref(),
            Some("first password")
        );
        let attributes = credential.0.inner.get_attributes().unwrap();
        assert_eq!(attributes["target_name"], format!("{tunnel_id}.{service}"));

        vault.set(tunnel_id, "replacement").unwrap();
        assert_eq!(
            vault.get(tunnel_id).unwrap().as_deref(),
            Some("replacement")
        );
        vault.delete(tunnel_id).unwrap();
        assert_eq!(vault.get(tunnel_id).unwrap(), None);
        vault.delete(tunnel_id).unwrap();
    }
}
