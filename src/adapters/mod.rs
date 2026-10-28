mod git;
mod process;
mod semantic;
pub use git::GitDiffSource;
pub(crate) use process::output;
pub use semantic::SemanticCli;
