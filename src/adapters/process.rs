use crate::domain::DiffError;
use std::process::Stdio;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

/// Drain stdout/stderr while writing stdin to avoid pipe deadlocks. Dropping this
/// future kills the child, including when the application deadline expires.
pub async fn output(
    mut command: Command,
    program: &'static str,
    input: Option<Vec<u8>>,
    limit: usize,
) -> Result<Vec<u8>, DiffError> {
    let error = |e: std::io::Error| DiffError::Process {
        program,
        message: e.to_string(),
    };
    let mut child = command
        .kill_on_drop(true)
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(error)?;
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stdin = child.stdin.take();
    let write = async {
        if let (Some(mut pipe), Some(bytes)) = (stdin, input) {
            pipe.write_all(&bytes).await.map_err(error)?;
        }
        Ok::<_, DiffError>(())
    };
    let read = async {
        let mut bytes = Vec::new();
        stdout
            .take((limit + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(error)?;
        if bytes.len() > limit {
            return Err(DiffError::TooLarge { limit });
        }
        Ok(bytes)
    };
    let errors = async {
        // Keep only bounded diagnostic output; continue draining the pipe.
        let mut pipe = stderr;
        let mut kept = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let count = pipe.read(&mut chunk).await.map_err(error)?;
            if count == 0 {
                break;
            }
            let take = count.min(8192usize.saturating_sub(kept.len()));
            kept.extend_from_slice(&chunk[..take]);
        }
        Ok::<_, DiffError>(kept)
    };
    let (_, bytes, stderr) = tokio::try_join!(write, read, errors)?;
    let status = child.wait().await.map_err(error)?;
    if !status.success() {
        return Err(DiffError::Process {
            program,
            message: String::from_utf8_lossy(&stderr).trim().to_owned(),
        });
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn rejects_oversized_output() {
        let mut command = Command::new("printf");
        command.arg("123456789");
        assert_eq!(
            output(command, "printf", None, 4).await.unwrap_err(),
            DiffError::TooLarge { limit: 4 }
        );
    }

    #[tokio::test]
    async fn drains_stdout_while_writing_stdin() {
        let command = Command::new("cat");
        let payload = vec![b'x'; 256 * 1024];
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            output(command, "cat", Some(payload.clone()), payload.len()),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(result, payload);
    }
}
