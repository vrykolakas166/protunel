FROM debian:12.12-slim

ARG WITH_RSYNC=1
RUN set -eux; \
    apt-get update; \
    packages="openssh-server openssh-client python3"; \
    if [ "$WITH_RSYNC" = 1 ]; then packages="$packages rsync"; fi; \
    apt-get install -y --no-install-recommends $packages; \
    rm -rf /var/lib/apt/lists/* /etc/ssh/ssh_host_*; \
    mkdir -p /run/sshd /srv/http; \
    printf 'protunel ssh-it\n' > /srv/http/fixture.txt; \
    useradd -m -s /bin/sh alice; \
    useradd -m -s /bin/sh bob; \
    printf '%s\n' 'alice:alice-pass' 'bob:disabled-fixture-password' | chpasswd; \
    install -d -o bob -g bob -m 0700 /home/bob/.ssh

COPY generated-keys/id_ed25519 generated-keys/id_ed25519.pub /tmp/test-keys/
RUN install -o bob -g bob -m 0600 /tmp/test-keys/id_ed25519 /home/bob/.ssh/id_ed25519; \
    install -o bob -g bob -m 0600 /tmp/test-keys/id_ed25519.pub /home/bob/.ssh/authorized_keys; \
    rm -r /tmp/test-keys

COPY sshd_config /etc/ssh/sshd_config
COPY entrypoint.sh /usr/local/bin/ssh-it-entrypoint
COPY scp.sh /usr/local/bin/scp
RUN chmod 0755 /usr/local/bin/scp
ENTRYPOINT ["/bin/sh", "/usr/local/bin/ssh-it-entrypoint"]
