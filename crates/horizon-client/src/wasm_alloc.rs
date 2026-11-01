//! The browser build's global allocator: dlmalloc, as in std, over wasm memory grown in
//! large steps.
//!
//! std's wasm allocator grows the memory by the few 64 KiB pages each request needs. On a
//! shared memory every `memory.grow` costs milliseconds (the browser updates every Worker
//! that sees the memory: ~5 ms each with the game's Workers alive), so loading the world
//! data, which grows the memory by ~400 MiB, took 13-15 s against 0.3 s natively. Growing
//! by [`STEP`] at a time makes that a dozen grows.
//!
//! Memory is only ever grown (wasm cannot shrink it), and only by this allocator, so the
//! unused tail of the last step ([`Reserve`]) is always contiguous with the next one.
use core::{
    alloc::{GlobalAlloc, Layout},
    cell::{Cell, UnsafeCell},
    ptr,
    sync::atomic::{AtomicBool, Ordering},
};
#[cfg(target_arch = "wasm32")]
use core::arch::wasm32 as wasm;
#[cfg(target_arch = "wasm64")]
use core::arch::wasm64 as wasm;

const PAGE: usize = 64 * 1024;
/// How far the memory grows at once: 32 MiB, at most that much unused at the end.
const STEP: usize = 32 * 1024 * 1024;

/// dlmalloc's source of memory: the unused tail of the last grow.
struct Reserve {
    at: Cell<usize>,
    len: Cell<usize>,
}
// SAFETY: only used under `Locked`'s lock.
unsafe impl Send for Reserve {}

unsafe impl dlmalloc::Allocator for Reserve {
    fn alloc(&self, size: usize) -> (*mut u8, usize, u32) {
        let size = size.div_ceil(PAGE) * PAGE;
        if self.len.get() < size {
            let grow = (size - self.len.get()).max(STEP).div_ceil(PAGE);
            let previous = wasm::memory_grow(0, grow);
            if previous == usize::MAX {
                // The browser refused a whole step: try for just what is missing.
                let missing = (size - self.len.get()).div_ceil(PAGE);
                let previous = wasm::memory_grow(0, missing);
                if previous == usize::MAX {
                    return (ptr::null_mut(), 0, 0);
                }
                self.extend(previous * PAGE, missing * PAGE);
            } else {
                self.extend(previous * PAGE, grow * PAGE);
            }
        }
        let at = self.at.get();
        self.at.set(at + size);
        self.len.set(self.len.get() - size);
        (at as *mut u8, size, 0)
    }
    fn remap(&self, _: *mut u8, _: usize, _: usize, _: bool) -> *mut u8 {
        ptr::null_mut()
    }
    fn free_part(&self, _: *mut u8, _: usize, _: usize) -> bool {
        false
    }
    fn free(&self, _: *mut u8, _: usize) -> bool {
        false
    }
    fn can_release_part(&self, _: u32) -> bool {
        false
    }
    fn allocates_zeros(&self) -> bool {
        // Fresh wasm pages are zero and the reserve hands each byte out once.
        true
    }
    fn page_size(&self) -> usize {
        PAGE
    }
}
impl Reserve {
    /// Adds `len` bytes grown at `start`; a gap after the old reserve (which nothing else
    /// should cause) drops the old tail rather than handing out memory it does not own.
    fn extend(&self, start: usize, len: usize) {
        if self.at.get() + self.len.get() != start {
            self.at.set(start);
            self.len.set(0);
        }
        self.len.set(self.len.get() + len);
    }
}

/// dlmalloc behind a spin lock. The page's main thread may not block (`Atomics.wait`
/// throws there), and std's wasm allocator spins the same way.
pub struct Locked {
    busy: AtomicBool,
    heap: UnsafeCell<dlmalloc::Dlmalloc<Reserve>>,
}
// SAFETY: `heap` is only reached while `busy` is held.
unsafe impl Sync for Locked {}

impl Locked {
    pub const fn new() -> Self {
        Self {
            busy: AtomicBool::new(false),
            heap: UnsafeCell::new(dlmalloc::Dlmalloc::new_with_allocator(Reserve {
                at: Cell::new(0),
                len: Cell::new(0),
            })),
        }
    }
    fn with<T>(&self, f: impl FnOnce(&mut dlmalloc::Dlmalloc<Reserve>) -> T) -> T {
        while self
            .busy
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            core::hint::spin_loop();
        }
        // SAFETY: the lock is held until the end of this call.
        let out = f(unsafe { &mut *self.heap.get() });
        self.busy.store(false, Ordering::Release);
        out
    }
}

unsafe impl GlobalAlloc for Locked {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        self.with(|heap| unsafe { heap.malloc(layout.size(), layout.align()) })
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        self.with(|heap| unsafe { heap.calloc(layout.size(), layout.align()) })
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        self.with(|heap| unsafe { heap.free(ptr, layout.size(), layout.align()) })
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        self.with(|heap| unsafe { heap.realloc(ptr, layout.size(), layout.align(), new_size) })
    }
}
