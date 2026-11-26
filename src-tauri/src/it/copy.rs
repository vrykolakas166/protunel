use super::*;
use crate::commands::{files_copy_across, files_retry};
use files::{Conflict, Route};

struct Pair {
    source: Tunnel,
    dest: Tunnel,
    dir: String,
}

impl Pair {
    async fn connect(case: &mut Case, dest_service: &str) -> Self {
        let mut source = case.tunnel("127.0.0.1", 2201);
        bob(&mut source);
        // Keep the destination's SSH endpoint usable both by the app (through
        // A's jump channel) and by the OpenSSH client running on A.
        let mut dest = case.tunnel(dest_service, 22);
        dest.jump_tunnel_id = Some(source.id);
        bob(&mut dest);
        case.save(&source);
        case.save(&dest);
        case.trust(&source, "srv-a").await;
        case.trust(&dest, dest_service).await;
        case.connect(&dest).await;
        let dir = format!("/tmp/protunel-it-{}", source.id);
        case.exec(&source, &format!("mkdir {dir}")).await;
        case.exec(&dest, &format!("mkdir {dir}")).await;
        Self { source, dest, dir }
    }

    async fn queue(&self, case: &Case, name: &str, route: Route, overwrite: bool) -> Uuid {
        let conflict = if overwrite { Conflict::Replace } else { Conflict::Skip };
        self.queue_with(case, name, route, conflict).await
    }

    async fn queue_with(&self, case: &Case, name: &str, route: Route, conflict: Conflict) -> Uuid {
        let copy = files_copy_across(
            case.app.clone(),
            case.app.state(),
            self.source.id,
            vec![format!("{}/{name}", self.dir)],
            self.dest.id,
            self.dir.clone(),
            conflict,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(copy.route, route);
        assert_eq!(copy.transfer_ids.len(), 1);
        copy.transfer_ids[0]
    }

    async fn assert_transfer(&self, case: &Case, id: Uuid, route: Route, state: TransferState) {
        let item = case.finished(id, state).await;
        assert_eq!(item.route, Some(route));
        assert_eq!(item.tunnel_id, self.source.id);
        assert_eq!(item.dest_tunnel_id, Some(self.dest.id));
    }

    async fn read(&self, case: &Case, name: &str) -> Vec<u8> {
        let sftp = files::sftp_for(case.app, self.dest.id).await.unwrap();
        sftp.read(format!("{}/{name}", self.dir)).await.unwrap()
    }
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_copy_rsync_direct() {
    run(async |case| {
        let pair = Pair::connect(case, "srv-b").await;
        case.exec(
            &pair.source,
            &format!("printf 'via rsync' > {}/sample.txt", pair.dir),
        )
        .await;
        let id = pair.queue(case, "sample.txt", Route::Rsync, false).await;
        pair.assert_transfer(case, id, Route::Rsync, TransferState::Done)
            .await;
        assert_eq!(pair.read(case, "sample.txt").await, b"via rsync");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_copy_rsync_keep_both_lands_under_a_free_name() {
    run(async |case| {
        let pair = Pair::connect(case, "srv-b").await;
        case.exec(&pair.source, &format!("mkdir {0}/box && printf mine > {0}/box/f", pair.dir)).await;
        case.exec(&pair.dest, &format!("mkdir {0}/box && printf theirs > {0}/box/f", pair.dir)).await;
        let id = pair.queue_with(case, "box", Route::Rsync, Conflict::KeepBoth).await;
        let done = case.finished(id, TransferState::Done).await;
        assert_eq!(done.name, "box (1)");
        assert_eq!(pair.read(case, "box/f").await, b"theirs");
        assert_eq!(pair.read(case, "box (1)/f").await, b"mine");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_copy_scp_single_file_without_rsync() {
    run(async |case| {
        let pair = Pair::connect(case, "srv-norsync").await;
        case.exec(
            &pair.source,
            &format!("printf 'via scp' > {}/sample.txt", pair.dir),
        )
        .await;
        let id = pair.queue(case, "sample.txt", Route::Scp, false).await;
        pair.assert_transfer(case, id, Route::Scp, TransferState::Done)
            .await;
        assert_eq!(pair.read(case, "sample.txt").await, b"via scp");
        assert_eq!(
            case.exec(&pair.dest, &format!("ls -A {}", pair.dir))
                .await
                .trim(),
            "sample.txt"
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_copy_relay_folder_without_rsync() {
    run(async |case| {
        let pair = Pair::connect(case, "srv-norsync").await;
        let folder = format!("{}/folder/nested", pair.dir);
        case.exec(
            &pair.source,
            &format!("mkdir -p {folder} && printf 'via relay' > {folder}/sample.txt"),
        )
        .await;
        let id = pair.queue(case, "folder", Route::Relay, false).await;
        pair.assert_transfer(case, id, Route::Relay, TransferState::Done)
            .await;
        assert_eq!(
            pair.read(case, "folder/nested/sample.txt").await,
            b"via relay"
        );
        assert!(case
            .exec(
                &pair.dest,
                &format!("find {} -name '*.protunel-part'", pair.dir)
            )
            .await
            .is_empty());
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_copy_cancel_cleans_destination_stage() {
    run(async |case| {
        let pair = Pair::connect(case, "srv-norsync").await;
        case.exec(
            &pair.source,
            &format!("truncate -s 8M {}/slow-copy.bin", pair.dir),
        )
        .await;
        let id = pair.queue(case, "slow-copy.bin", Route::Scp, false).await;
        let sftp = files::sftp_for(case.app, pair.dest.id).await.unwrap();
        until("partially written SCP staging file", async || {
            for entry in sftp.read_dir(pair.dir.as_str()).await.unwrap() {
                let name = entry.file_name();
                if name.ends_with(".protunel-part") {
                    let path = format!("{}/{name}/slow-copy.bin", pair.dir);
                    if let Ok(metadata) = sftp.metadata(path.as_str()).await {
                        if metadata
                            .size
                            .is_some_and(|size| size > 0 && size < 8 * 1024 * 1024)
                        {
                            return Some(());
                        }
                    }
                }
            }
            None
        })
        .await;
        files::cancel(case.app, id);
        pair.assert_transfer(case, id, Route::Scp, TransferState::Cancelled)
            .await;
        assert_eq!(sftp.read_dir(pair.dir.as_str()).await.unwrap().count(), 0);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_copy_top_level_name_skipped_unless_overwrite() {
    run(async |case| {
        let pair = Pair::connect(case, "srv-b").await;
        let path = format!("{}/same.txt", pair.dir);
        case.exec(&pair.source, &format!("printf new > {path}"))
            .await;
        case.exec(&pair.dest, &format!("printf old > {path}")).await;
        let skipped = pair.queue(case, "same.txt", Route::Rsync, false).await;
        pair.assert_transfer(case, skipped, Route::Rsync, TransferState::Skipped)
            .await;
        assert_eq!(pair.read(case, "same.txt").await, b"old");

        let replaced = pair.queue(case, "same.txt", Route::Rsync, true).await;
        pair.assert_transfer(case, replaced, Route::Rsync, TransferState::Done)
            .await;
        assert_eq!(pair.read(case, "same.txt").await, b"new");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_copy_retry_refused_keeps_its_row() {
    run(async |case| {
        let pair = Pair::connect(case, "srv-b").await;
        case.exec(&pair.source, &format!("printf x > {}/f", pair.dir)).await;
        case.exec(&pair.dest, &format!("mkdir {0}/ro && chmod 555 {0}/ro", pair.dir)).await;
        let copy = files_copy_across(
            case.app.clone(),
            case.app.state(),
            pair.source.id,
            vec![format!("{}/f", pair.dir)],
            pair.dest.id,
            format!("{}/ro", pair.dir),
            Conflict::Skip,
            None,
            None,
            None,
        )
        .await
        .unwrap();
        let id = copy.transfer_ids[0];
        case.finished(id, TransferState::Failed).await;

        // B is down: the retry is refused and the row stays, still retryable.
        case.state().stop_and_wait(pair.dest.id).await;
        assert!(files_retry(case.app.clone(), case.app.state(), id, None).await.is_err());
        assert!(files::transfers(case.app).iter().any(|x| x.id == id));

        case.connect(&pair.dest).await;
        case.exec(&pair.dest, &format!("chmod 755 {}/ro", pair.dir)).await;
        let retried = files_retry(case.app.clone(), case.app.state(), id, None).await.unwrap();
        case.finished(retried[0], TransferState::Done).await;
        assert!(files::transfers(case.app).iter().all(|x| x.id != id));
        assert_eq!(pair.read(case, "ro/f").await, b"x");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_copy_rsync_partial_then_retry() {
    run(async |case| {
        let pair = Pair::connect(case, "srv-b").await;
        case.exec(
            &pair.source,
            &format!("mkdir {0}/box && printf 1 > {0}/box/one && printf 2 > {0}/box/two && chmod 000 {0}/box/two", pair.dir),
        )
        .await;
        let id = pair.queue(case, "box", Route::Rsync, false).await;
        let partial = case.finished(id, TransferState::Failed).await;
        assert_eq!(partial.error.as_deref(), Some("partial"));
        assert_eq!(partial.files_done, 1);
        assert_eq!(partial.files_failed, 1, "{:?}", partial.failures);
        assert_eq!(pair.read(case, "box/one").await, b"1");

        case.exec(&pair.source, &format!("chmod 644 {}/box/two", pair.dir)).await;
        let retried = files_retry(case.app.clone(), case.app.state(), id, None).await.unwrap();
        case.finished(retried[0], TransferState::Done).await;
        assert_eq!(pair.read(case, "box/two").await, b"2");
    })
    .await;
}
