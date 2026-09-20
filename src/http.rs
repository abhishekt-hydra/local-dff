//! HTTP adapter: resolve session selections, call the input port, map typed errors.
use crate::{
    domain::{DiffArtifact, DiffError, DiffInput, DiffKind, SemanticResponse},
    ApiError, AppState,
};
use axum::{
    extract::{Path, State},
    http::{header, StatusCode},
};

impl From<DiffError> for ApiError {
    fn from(error: DiffError) -> Self {
        let status = match &error {
            DiffError::Timeout => StatusCode::GATEWAY_TIMEOUT,
            DiffError::TooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
            DiffError::InvalidText | DiffError::InvalidSemantic(_) => {
                StatusCode::UNPROCESSABLE_ENTITY
            }
            DiffError::Process { .. } | DiffError::Storage(_) | DiffError::UnexpectedArtifact => {
                StatusCode::INTERNAL_SERVER_ERROR
            }
        };
        Self {
            status,
            message: error.to_string(),
        }
    }
}

fn input(state: &AppState, id: &str, index: usize) -> Result<DiffInput, ApiError> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(id)
        .ok_or_else(|| ApiError::bad_request("This session has expired. Reload the comparison."))?;
    let file = session
        .files
        .get(index)
        .cloned()
        .ok_or_else(|| ApiError::bad_request("Unknown file index."))?;
    Ok(DiffInput {
        repo: session.repo.clone(),
        base: session.base.clone(),
        target: session.target.clone(),
        file,
    })
}

pub async fn text_diff(
    State(state): State<AppState>,
    Path((id, index)): Path<(String, usize)>,
) -> Result<([(header::HeaderName, &'static str); 1], String), ApiError> {
    let result = state
        .diffs
        .load(input(&state, &id, index)?, DiffKind::Text)
        .await?;
    match result.as_ref() {
        DiffArtifact::Text(text) => Ok((
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            text.clone(),
        )),
        DiffArtifact::Semantic(_) => Err(DiffError::UnexpectedArtifact.into()),
    }
}

pub async fn semantic_response(
    state: &AppState,
    id: &str,
    index: usize,
) -> Result<SemanticResponse, ApiError> {
    let result = state
        .diffs
        .load(input(state, id, index)?, DiffKind::Semantic)
        .await?;
    match result.as_ref() {
        DiffArtifact::Semantic(result) => Ok(result.clone()),
        DiffArtifact::Text(_) => Err(DiffError::UnexpectedArtifact.into()),
    }
}
