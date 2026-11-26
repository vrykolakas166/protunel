use super::*;
use crate::commands::{
    files_delete, files_list, files_paste, files_read_text, files_rename, files_retry, files_upload,
    files_write_text,
};
use files::{Conflict, Content, DownloadJob};

async fn connect(case: &mut Case) -> (Tunnel, String) {
    let tunnel = case.tunnel("127.0.0.1", 2201);
    case.save(&tunnel);
    case.trust(&tunnel, "srv-a").await;
    case.connect(&tunnel).await;
    let dir = format!("/tmp/protunel-it-{}", tunnel.id);
    case.exec(&tunnel, &format!("mkdir {dir}")).await;
    (tunnel, dir)
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_sftp_list_upload_download() {
    run(async |case| {
        let (tunnel, dir) = connect(case).await;
        let local = case.local_dir().to_path_buf();
        let upload = local.join("name.ext");
        let download_dir = local.join("downloads");
        std::fs::create_dir(&download_dir).unwrap();
        // Keep the download in progress across at least one directory poll.
        let payload = vec![b'x'; 16 * 1024 * 1024];
        std::fs::write(&upload, &payload).unwrap();
        std::fs::write(download_dir.join("name.ext"), b"original").unwrap();

        let ids = files_upload(
            case.app.clone(),
            tunnel.id,
            vec![upload.to_string_lossy().into_owned()],
            dir.clone(),
            Conflict::Skip,
        );
        let uploaded = case.finished(ids[0], TransferState::Done).await;
        assert_eq!(uploaded.done, payload.len() as u64);
        let listing = files_list(case.app.clone(), tunnel.id, dir.clone())
            .await
            .unwrap();
        assert_eq!(listing.entries.len(), 1);
        assert_eq!(listing.entries[0].name, "name.ext");
        assert_eq!(listing.entries[0].size, payload.len() as u64);

        let id = files::start_download(
            case.app,
            tunnel.id,
            DownloadJob {
                remote: format!("{dir}/name.ext"),
                local_dir: download_dir.clone(),
                open_when_done: false,
                into: None,
            },
        );
        let part = bounded("local download part to appear", async {
            loop {
                let part = std::fs::read_dir(&download_dir)
                    .unwrap()
                    .map(Result::unwrap)
                    .find(|entry| {
                        entry
                            .file_name()
                            .to_string_lossy()
                            .ends_with(".protunel-part")
                    });
                if let Some(part) = part {
                    break part.path();
                }
                sleep(Duration::from_millis(1)).await;
            }
        })
        .await;
        let downloaded = case.finished(id, TransferState::Done).await;
        let final_path = download_dir.join("name (1).ext");
        assert_eq!(Path::new(&downloaded.local_path), final_path);
        assert_eq!(std::fs::read(final_path).unwrap(), payload);
        assert_eq!(
            std::fs::read(download_dir.join("name.ext")).unwrap(),
            b"original"
        );
        assert!(!part.exists());
        assert_eq!(std::fs::read_dir(download_dir).unwrap().count(), 2);
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_sftp_write_text_detects_conflict() {
    run(async |case| {
        let (tunnel, dir) = connect(case).await;
        let path = format!("{dir}/edit.txt");
        let sftp = files::sftp_for(case.app, tunnel.id).await.unwrap();
        sftp.write(path.as_str(), b"initial").await.unwrap();
        let Content::Text {
            text, size, mtime, hash, ..
        } = files_read_text(case.app.clone(), tunnel.id, path.clone(), false)
            .await
            .unwrap()
        else {
            panic!("expected editable text")
        };
        assert_eq!(text, "initial");
        case.exec(&tunnel, &format!("printf 'changed remotely' > {path}"))
            .await;

        let result = files_write_text(
            case.app.clone(),
            tunnel.id,
            path.clone(),
            "my edit".into(),
            size,
            mtime,
            hash,
            false,
            false,
        )
        .await;
        assert!(matches!(result, Err(ref error) if error == "conflict"));
        assert_eq!(sftp.read(path.as_str()).await.unwrap(), b"changed remotely");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_sftp_write_text_detects_same_size_same_mtime_change() {
    run(async |case| {
        let (tunnel, dir) = connect(case).await;
        let path = format!("{dir}/same.txt");
        let sftp = files::sftp_for(case.app, tunnel.id).await.unwrap();
        sftp.write(path.as_str(), b"aaaa").await.unwrap();
        let Content::Text {
            size, mtime, hash, ..
        } = files_read_text(case.app.clone(), tunnel.id, path.clone(), false)
            .await
            .unwrap()
        else {
            panic!("expected editable text")
        };
        // Another editor: same length, mtime kept (what SFTP v3 can't tell apart).
        case.exec(
            &tunnel,
            &format!("printf bbbb > {path}.n && touch -r {path} {path}.n && mv {path}.n {path}"),
        )
        .await;

        let result = files_write_text(
            case.app.clone(),
            tunnel.id,
            path.clone(),
            "mine".into(),
            size,
            mtime,
            hash,
            false,
            false,
        )
        .await;
        assert!(matches!(result, Err(ref error) if error == "conflict"));
        assert_eq!(sftp.read(path.as_str()).await.unwrap(), b"bbbb");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_sftp_delete_tree_preserves_symlink_target() {
    run(async |case| {
        let (tunnel, dir) = connect(case).await;
        case.exec(
            &tunnel,
            &format!(
                "mkdir -p {dir}/tree/nested {dir}/outside &&
             printf safe > {dir}/outside/keep &&
             touch {dir}/tree/nested/delete &&
             ln -s {dir}/outside {dir}/tree/nested/link"
            ),
        )
        .await;
        files_delete(case.app.clone(), tunnel.id, vec![format!("{dir}/tree")])
            .await
            .unwrap();
        let sftp = files::sftp_for(case.app, tunnel.id).await.unwrap();
        assert!(!files::exists(&sftp, &format!("{dir}/tree")).await.unwrap());
        assert_eq!(
            sftp.read(format!("{dir}/outside/keep")).await.unwrap(),
            b"safe"
        );
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_sftp_paste_and_rename_skip_name_clash() {
    run(async |case| {
        let (tunnel, dir) = connect(case).await;
        let source = format!("{dir}/same.txt");
        let target = format!("{dir}/dest/same.txt");
        case.exec(
            &tunnel,
            &format!("mkdir {dir}/dest && printf source > {source} && printf target > {target}"),
        )
        .await;
        let outcome = files_paste(
            case.app.clone(),
            case.app.state(),
            tunnel.id,
            vec![source.clone()],
            format!("{dir}/dest"),
            true,
        )
        .await
        .unwrap();
        assert!(outcome.done.is_empty());
        assert_eq!(outcome.skipped, [source.clone()]);
        let renamed =
            files_rename(case.app.clone(), tunnel.id, source.clone(), target.clone()).await;
        assert_eq!(renamed, Err("exists".into()));
        let sftp = files::sftp_for(case.app, tunnel.id).await.unwrap();
        assert_eq!(sftp.read(source).await.unwrap(), b"source");
        assert_eq!(sftp.read(target).await.unwrap(), b"target");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_sftp_upload_keep_both_takes_a_free_name() {
    run(async |case| {
        let (tunnel, dir) = connect(case).await;
        let local = case.local_dir().join("a.txt");
        std::fs::write(&local, b"mine").unwrap();
        case.exec(&tunnel, &format!("printf theirs > {dir}/a.txt")).await;
        let local = local.to_string_lossy().into_owned();

        let ids = files_upload(case.app.clone(), tunnel.id, vec![local.clone()], dir.clone(), Conflict::Skip);
        case.finished(ids[0], TransferState::Skipped).await;
        let ids = files_upload(case.app.clone(), tunnel.id, vec![local], dir.clone(), Conflict::KeepBoth);
        let done = case.finished(ids[0], TransferState::Done).await;
        assert_eq!(done.name, "a (1).txt");
        assert_eq!(done.remote_path, format!("{dir}/a (1).txt"));
        let sftp = files::sftp_for(case.app, tunnel.id).await.unwrap();
        assert_eq!(sftp.read(format!("{dir}/a.txt")).await.unwrap(), b"theirs");
        assert_eq!(sftp.read(format!("{dir}/a (1).txt")).await.unwrap(), b"mine");
    })
    .await;
}

#[tokio::test]
#[ignore = "needs docker/it (PROTUNEL_IT=1)"]
async fn it_sftp_folder_upload_goes_on_past_a_failed_file_and_retries() {
    run(async |case| {
        let (tunnel, dir) = connect(case).await;
        let tree = case.local_dir().join("tree");
        std::fs::create_dir_all(tree.join("locked")).unwrap();
        std::fs::write(tree.join("one"), b"1").unwrap();
        std::fs::write(tree.join("locked/two"), b"2").unwrap();
        std::fs::write(tree.join("three"), b"3").unwrap();
        // The folder is there already, with a subfolder this user can't write.
        case.exec(&tunnel, &format!("mkdir -p {dir}/tree/locked && chmod 555 {dir}/tree/locked")).await;

        let ids = files_upload(
            case.app.clone(),
            tunnel.id,
            vec![tree.to_string_lossy().into_owned()],
            dir.clone(),
            Conflict::Replace,
        );
        let partial = case.finished(ids[0], TransferState::Failed).await;
        assert_eq!(partial.error.as_deref(), Some("partial"));
        assert_eq!(partial.files_done, 2);
        assert_eq!(partial.files_failed, 1);
        assert!(partial.failures[0].contains("locked/two"), "{:?}", partial.failures);

        case.exec(&tunnel, &format!("chmod 755 {dir}/tree/locked")).await;
        let retried = files_retry(case.app.clone(), case.app.state(), ids[0]).await.unwrap();
        let done = case.finished(retried[0], TransferState::Done).await;
        // Only the missing file travelled again.
        assert_eq!(done.done, 1);
        assert!(files::transfers(case.app).iter().all(|x| x.id != ids[0]));
        let sftp = files::sftp_for(case.app, tunnel.id).await.unwrap();
        assert_eq!(sftp.read(format!("{dir}/tree/locked/two")).await.unwrap(), b"2");
    })
    .await;
}
