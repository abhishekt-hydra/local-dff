//! Storage adapters. Foyer types never cross the application port.
mod foyer;
pub use foyer::FoyerDiffStore;
