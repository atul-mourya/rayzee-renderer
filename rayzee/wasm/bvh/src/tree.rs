//! What follows the build: `ReinsertionOptimizer.optimizeBVH` (rayzee/src/bvh/ReinsertionOptimizer.js), then
//! `BVHBuilder.applySAOrdering` and `flattenBVH`, on the nodes the build left. The same visiting orders, the same heap,
//! a stable sort and JavaScript's `Math.min` / `Math.max` (NaN and ±0), so the flat tree is the JS one bit for bit.

use crate::{ensure, INNER, NODES, NODE_CAP, NODE_COUNT, NODE_U32, STATS};

const NONE: u32 = u32::MAX;
const TRIANGLE_LEAF: u32 = 0x4000_0000;
const FLAT_U32: usize = 16;

static mut TOP: usize = 0;
static mut LEFT: *mut u32 = core::ptr::null_mut();
static mut RIGHT: *mut u32 = core::ptr::null_mut();
static mut PARENT: *mut u32 = core::ptr::null_mut();
static mut IS_LEFT: *mut u8 = core::ptr::null_mut();
static mut TOUCHED: *mut u8 = core::ptr::null_mut();
static mut STACK: *mut u32 = core::ptr::null_mut();
static mut SEARCH_AREA: *mut f64 = core::ptr::null_mut();
static mut SEARCH_NODE: *mut u32 = core::ptr::null_mut();

unsafe fn bump<T>(count: usize) -> Option<*mut T> {
	let align = core::mem::align_of::<T>().max(8);
	let at = (TOP + align - 1) & !(align - 1);
	let end = at + count * core::mem::size_of::<T>();
	if !ensure(end) {
		return None;
	}
	TOP = end;
	Some(at as *mut T)
}

#[inline(always)]
unsafe fn bound(i: u32, k: usize) -> f64 {
	*(NODES.add(i as usize * NODE_U32 + k) as *const f32) as f64
}

#[inline(always)]
unsafe fn set_bound(i: u32, k: usize, v: f64) {
	*(NODES.add(i as usize * NODE_U32 + k) as *mut f32) = v as f32;
}

#[inline(always)]
unsafe fn inner(i: u32) -> bool {
	*NODES.add(i as usize * NODE_U32 + 7) == INNER
}

#[inline(always)]
unsafe fn area(i: u32) -> f64 {
	let dx = bound(i, 3) - bound(i, 0);
	let dy = bound(i, 4) - bound(i, 1);
	let dz = bound(i, 5) - bound(i, 2);
	dx * dy + dy * dz + dz * dx
}

/// `Math.min`: NaN if either is, −0 below +0.
#[inline(always)]
fn js_min(a: f64, b: f64) -> f64 {
	if a != a || b != b {
		f64::NAN
	} else if a < b {
		a
	} else if b < a {
		b
	} else if a.is_sign_negative() {
		a
	} else {
		b
	}
}

/// `Math.max`: NaN if either is, +0 above −0.
#[inline(always)]
fn js_max(a: f64, b: f64) -> f64 {
	if a != a || b != b {
		f64::NAN
	} else if a > b {
		a
	} else if b > a {
		b
	} else if a.is_sign_negative() {
		b
	} else {
		a
	}
}

#[inline(always)]
unsafe fn sibling(n: u32) -> u32 {
	let p = *PARENT.add(n as usize);
	if *IS_LEFT.add(n as usize) != 0 { *RIGHT.add(p as usize) } else { *LEFT.add(p as usize) }
}

/// `buildParentMap`: every node's parent and side; returns how many nodes it reached.
unsafe fn parent_map() -> usize {
	*PARENT = NONE;
	*IS_LEFT = 0;
	let mut count = 1;
	let mut top = 0;
	*STACK = 0;
	top += 1;
	while top > 0 {
		top -= 1;
		let n = *STACK.add(top);
		if !inner(n) {
			continue;
		}
		for (child, left) in [(*LEFT.add(n as usize), 1u8), (*RIGHT.add(n as usize), 0u8)] {
			*PARENT.add(child as usize) = n;
			*IS_LEFT.add(child as usize) = left;
			count += 1;
			*STACK.add(top) = child;
			top += 1;
		}
	}
	count
}

unsafe fn sift_down(heap: *mut (u32, f64), len: usize, mut i: usize) {
	loop {
		let mut smallest = i;
		let (l, r) = (2 * i + 1, 2 * i + 2);
		if l < len && (*heap.add(l)).1 < (*heap.add(smallest)).1 { smallest = l; }
		if r < len && (*heap.add(r)).1 < (*heap.add(smallest)).1 { smallest = r; }
		if smallest == i {
			break;
		}
		core::ptr::swap(heap.add(i), heap.add(smallest));
		i = smallest;
	}
}

/// `findCandidates`: the `target` largest nodes by area, below the root's children, as the heap leaves them.
unsafe fn candidates(heap: *mut (u32, f64), target: usize) -> usize {
	let mut len = 0;
	let mut top = 1;
	*STACK = 0;
	while top > 0 {
		top -= 1;
		let n = *STACK.add(top);
		if n != 0 && *PARENT.add(n as usize) != 0 {
			let cost = area(n);
			if len < target {
				*heap.add(len) = (n, cost);
				len += 1;
				if len == target {
					for i in (0..len >> 1).rev() { sift_down(heap, len, i); }
				}
			} else if cost > (*heap).1 {
				*heap = (n, cost);
				sift_down(heap, len, 0);
			}
		}
		if inner(n) {
			*STACK.add(top) = *LEFT.add(n as usize);
			*STACK.add(top + 1) = *RIGHT.add(n as usize);
			top += 2;
		}
	}
	len
}

/// `findReinsertion`: where moving `a` gains the most area, and how much.
unsafe fn best_place(a: u32) -> Option<(u32, f64)> {
	let parent_a = *PARENT.add(a as usize);
	if parent_a == NONE {
		return None;
	}
	let sibling_a = sibling(a);
	let a_area = area(a);
	let mut best_to = NONE;
	let mut best = 0.0f64;
	let mut area_diff = area(parent_a);
	let mut pb = [0.0f64; 6];
	for k in 0..6 { pb[k] = bound(sibling_a, k); }
	let mut sibling_node = sibling_a;
	let mut pivot = parent_a;

	loop {
		let mut top = 1;
		*SEARCH_AREA = area_diff;
		*SEARCH_NODE = sibling_node;
		while top > 0 {
			top -= 1;
			let t = *SEARCH_NODE.add(top);
			let t_diff = *SEARCH_AREA.add(top);
			if t_diff - a_area <= best {
				continue;
			}
			let mut m = [0.0f64; 6];
			for k in 0..3 {
				m[k] = js_min(bound(t, k), bound(a, k));
				m[k + 3] = js_max(bound(t, k + 3), bound(a, k + 3));
			}
			let (dx, dy, dz) = (m[3] - m[0], m[4] - m[1], m[5] - m[2]);
			let reinsert = t_diff - (dx * dy + dy * dz + dz * dx);
			if reinsert > best {
				best_to = t;
				best = reinsert;
			}
			if inner(t) {
				let child = reinsert + area(t);
				if top + 2 > NODE_COUNT {
					core::arch::wasm32::unreachable();
				}
				*SEARCH_AREA.add(top) = child;
				*SEARCH_NODE.add(top) = *LEFT.add(t as usize);
				*SEARCH_AREA.add(top + 1) = child;
				*SEARCH_NODE.add(top + 1) = *RIGHT.add(t as usize);
				top += 2;
			}
		}

		let pivot_parent = *PARENT.add(pivot as usize);
		if pivot_parent == NONE {
			break;
		}
		if pivot != parent_a {
			for k in 0..3 {
				pb[k] = js_min(pb[k], bound(sibling_node, k));
				pb[k + 3] = js_max(pb[k + 3], bound(sibling_node, k + 3));
			}
			let (dx, dy, dz) = (pb[3] - pb[0], pb[4] - pb[1], pb[5] - pb[2]);
			area_diff += area(pivot) - (dx * dy + dy * dz + dz * dx);
		}
		sibling_node = sibling(pivot);
		pivot = pivot_parent;
	}

	if best_to == sibling_a || best_to == parent_a || best_to == NONE {
		return None;
	}
	Some((best_to, best))
}

unsafe fn refit_from(mut n: u32) {
	while n != NONE {
		if inner(n) {
			let (l, r) = (*LEFT.add(n as usize), *RIGHT.add(n as usize));
			for k in 0..3 {
				set_bound(n, k, js_min(bound(l, k), bound(r, k)));
				set_bound(n, k + 3, js_max(bound(l, k + 3), bound(r, k + 3)));
			}
		}
		n = *PARENT.add(n as usize);
	}
}

#[inline(always)]
unsafe fn set_child(parent: u32, left: bool, child: u32) {
	if left { *LEFT.add(parent as usize) = child; } else { *RIGHT.add(parent as usize) = child; }
}

/// `reinsertNode`: `a` leaves its parent, which takes `c`'s place with `a` and `c` under it.
unsafe fn reinsert(a: u32, c: u32) {
	let parent_a = *PARENT.add(a as usize);
	let sibling_a = sibling(a);
	let grand = *PARENT.add(parent_a as usize);
	let parent_a_left = *IS_LEFT.add(parent_a as usize) != 0;
	let target_parent = *PARENT.add(c as usize);
	let c_left = *IS_LEFT.add(c as usize) != 0;

	set_child(grand, parent_a_left, sibling_a);
	*LEFT.add(parent_a as usize) = a;
	*RIGHT.add(parent_a as usize) = c;
	for k in 0..3 {
		set_bound(parent_a, k, js_min(bound(a, k), bound(c, k)));
		set_bound(parent_a, k + 3, js_max(bound(a, k + 3), bound(c, k + 3)));
	}
	set_child(target_parent, c_left, parent_a);

	*PARENT.add(sibling_a as usize) = grand;
	*IS_LEFT.add(sibling_a as usize) = parent_a_left as u8;
	*PARENT.add(parent_a as usize) = target_parent;
	*IS_LEFT.add(parent_a as usize) = c_left as u8;
	*PARENT.add(a as usize) = parent_a;
	*IS_LEFT.add(a as usize) = 1;
	*PARENT.add(c as usize) = parent_a;
	*IS_LEFT.add(c as usize) = 0;

	refit_from(grand);
	refit_from(target_parent);
}

/// Stable merge sort, largest gain first, as `Array.prototype.sort` with `( a, b ) => b.areaDiff - a.areaDiff`.
unsafe fn sort_by_gain(list: *mut (u32, u32, f64), scratch: *mut (u32, u32, f64), n: usize) {
	let mut width = 1;
	let (mut src, mut dst) = (list, scratch);
	while width < n {
		let mut lo = 0;
		while lo < n {
			let mid = (lo + width).min(n);
			let hi = (lo + 2 * width).min(n);
			let (mut i, mut j, mut k) = (lo, mid, lo);
			while i < mid && j < hi {
				if (*src.add(j)).2 > (*src.add(i)).2 {
					*dst.add(k) = *src.add(j);
					j += 1;
				} else {
					*dst.add(k) = *src.add(i);
					i += 1;
				}
				k += 1;
			}
			while i < mid { *dst.add(k) = *src.add(i); i += 1; k += 1; }
			while j < hi { *dst.add(k) = *src.add(j); j += 1; k += 1; }
			lo = hi;
		}
		core::mem::swap(&mut src, &mut dst);
		width *= 2;
	}
	if src != list {
		core::ptr::copy_nonoverlapping(src, list, n);
	}
}

unsafe fn optimize(iterations: u32, ratio: f64) -> Option<()> {
	let n = NODE_COUNT;
	// The batch is at most a tenth of the nodes (setBatchSizeRatio's clamp); one entry more for the floor of 1.
	let cap = n / 10 + 2;
	let heap = bump::<(u32, f64)>(cap)?;
	let found = bump::<(u32, u32, f64)>(cap)?;
	let scratch = bump::<(u32, u32, f64)>(cap)?;

	for iter in 0..iterations {
		let nodes = parent_map();
		let target = libm_floor(nodes as f64 * ratio).max(1.0) as usize;
		if target > cap {
			core::arch::wasm32::unreachable();
		}
		let len = candidates(heap, target);

		let mut count = 0;
		for i in 0..len {
			if let Some((to, gain)) = best_place((*heap.add(i)).0) {
				if gain > 0.0 {
					*found.add(count) = ((*heap.add(i)).0, to, gain);
					count += 1;
				}
			}
		}
		sort_by_gain(found, scratch, count);

		core::ptr::write_bytes(TOUCHED, 0, n);
		let mut applied = 0u32;
		for i in 0..count {
			let (from, to, _) = *found.add(i);
			let conflicts = [to, from, sibling(from), *PARENT.add(to as usize), *PARENT.add(from as usize)];
			if conflicts.iter().any(|&c| *TOUCHED.add(c as usize) != 0) {
				continue;
			}
			for c in conflicts { *TOUCHED.add(c as usize) = 1; }
			reinsert(from, to);
			applied += 1;
		}
		STATS[6] += applied as f64;
		STATS[7] = (iter + 1) as f64;
		if applied == 0 {
			break;
		}
	}
	Some(())
}

/// `Math.floor` of a non-negative finite value.
#[inline(always)]
fn libm_floor(v: f64) -> f64 {
	let t = v as u64 as f64;
	if t > v { t - 1.0 } else { t }
}

/// Reinsertion (`iterations` passes, a `ratio` of the nodes each; 0 passes skips it), child ordering and the flat
/// layout of `flattenBVH`, leaf offsets plus `offset`. Returns the flat nodes' byte offset, 0 out of memory.
#[no_mangle]
pub unsafe extern "C" fn finish(iterations: u32, ratio: f64, offset: u32) -> u32 {
	let n = NODE_COUNT;
	TOP = NODES as usize + NODE_CAP * NODE_U32 * 4;
	let Some(()) = (|| -> Option<()> {
		LEFT = bump::<u32>(n)?;
		RIGHT = bump::<u32>(n)?;
		PARENT = bump::<u32>(n)?;
		IS_LEFT = bump::<u8>(n)?;
		TOUCHED = bump::<u8>(n)?;
		STACK = bump::<u32>(n + 2)?;
		SEARCH_AREA = bump::<f64>(n + 2)?;
		SEARCH_NODE = bump::<u32>(n + 2)?;
		Some(())
	})() else { return 0 };

	for i in 0..n as u32 {
		let inner_node = inner(i);
		*LEFT.add(i as usize) = if inner_node { i + 1 } else { NONE };
		*RIGHT.add(i as usize) = if inner_node { *NODES.add(i as usize * NODE_U32 + 6) } else { NONE };
	}

	if iterations > 0 && n > 1 && optimize(iterations, ratio).is_none() {
		return 0;
	}

	for i in 0..n as u32 {
		if !inner(i) {
			continue;
		}
		let (l, r) = (*LEFT.add(i as usize), *RIGHT.add(i as usize));
		if area(r) > area(l) {
			*LEFT.add(i as usize) = r;
			*RIGHT.add(i as usize) = l;
		}
	}

	let Some(out) = bump::<u32>(n * FLAT_U32) else { return 0 };
	let index = PARENT; // free now: the flat index of each node
	let order = STACK;
	let (mut top, mut count) = (1usize, 0u32);
	*SEARCH_NODE = 0;
	while top > 0 {
		top -= 1;
		let node = *SEARCH_NODE.add(top);
		*index.add(node as usize) = count;
		*order.add(count as usize) = node;
		count += 1;
		if inner(node) {
			*SEARCH_NODE.add(top) = *RIGHT.add(node as usize);
			*SEARCH_NODE.add(top + 1) = *LEFT.add(node as usize);
			top += 2;
		}
	}

	core::ptr::write_bytes(out, 0, n * FLAT_U32);
	for k in 0..count as usize {
		let node = *order.add(k);
		let o = out.add(k * FLAT_U32);
		let rec = NODES.add(node as usize * NODE_U32);
		if inner(node) {
			let (l, r) = (*LEFT.add(node as usize), *RIGHT.add(node as usize));
			let (lr, rr) = (NODES.add(l as usize * NODE_U32), NODES.add(r as usize * NODE_U32));
			for j in 0..3 {
				*o.add(j) = *lr.add(j);
				*o.add(4 + j) = *lr.add(3 + j);
				*o.add(8 + j) = *rr.add(j);
				*o.add(12 + j) = *rr.add(3 + j);
			}
			*o.add(3) = *index.add(l as usize);
			*o.add(7) = *index.add(r as usize);
		} else {
			*o = *rec.add(6) + offset;
			*o.add(1) = *rec.add(7);
			*o.add(3) = TRIANGLE_LEAF;
		}
	}
	out as u32
}
