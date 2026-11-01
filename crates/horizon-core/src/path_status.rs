//! Filesystem predicates on paths, plus passthrough predicates on metadata.
//! This lets the original resource traversal use the session mount on the web.
use std::path::{Path, PathBuf};

pub trait PathStatus {
    fn path_exists(&self) -> bool;
    fn path_is_dir(&self) -> bool;
    fn path_is_file(&self) -> bool;
}
impl PathStatus for Path {
    fn path_exists(&self) -> bool {
        crate::session_io::exists(self)
    }
    fn path_is_dir(&self) -> bool {
        crate::session_io::is_dir(self)
    }
    fn path_is_file(&self) -> bool {
        crate::session_io::is_file(self)
    }
}
impl PathStatus for PathBuf {
    fn path_exists(&self) -> bool {
        self.as_path().path_exists()
    }
    fn path_is_dir(&self) -> bool {
        self.as_path().path_is_dir()
    }
    fn path_is_file(&self) -> bool {
        self.as_path().path_is_file()
    }
}
impl<T: PathStatus + ?Sized> PathStatus for &T {
    fn path_exists(&self) -> bool {
        (**self).path_exists()
    }
    fn path_is_dir(&self) -> bool {
        (**self).path_is_dir()
    }
    fn path_is_file(&self) -> bool {
        (**self).path_is_file()
    }
}
macro_rules! metadata {
    ($ty:ty) => {
        impl PathStatus for $ty {
            fn path_exists(&self) -> bool {
                true
            }
            fn path_is_dir(&self) -> bool {
                self.is_dir()
            }
            fn path_is_file(&self) -> bool {
                self.is_file()
            }
        }
    };
}
metadata!(std::fs::Metadata);
metadata!(std::fs::FileType);
#[cfg(target_family = "wasm")]
metadata!(crate::session_io::Metadata);
#[cfg(target_family = "wasm")]
metadata!(crate::session_io::FileType);
#[cfg(any(target_family = "wasm", test))]
metadata!(crate::resource_io::mounted::Metadata);
#[cfg(any(target_family = "wasm", test))]
metadata!(crate::resource_io::mounted::FileType);

pub fn exists<T: PathStatus + ?Sized>(p: &T) -> bool {
    p.path_exists()
}
pub fn is_dir<T: PathStatus + ?Sized>(p: &T) -> bool {
    p.path_is_dir()
}
pub fn is_file<T: PathStatus + ?Sized>(p: &T) -> bool {
    p.path_is_file()
}
