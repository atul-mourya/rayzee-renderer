/**
 * ReinsertionOptimizer — BVH quality improvement via node reinsertion.
 *
 * Based on "Parallel Reinsertion for Bounding Volume Hierarchy Optimization"
 * by Meister & Bittner, adapted from madmann91/bvh (MIT).
 *
 * Algorithm:
 *   1. Find the top N nodes by surface area (highest traversal cost).
 *   2. For each candidate, search the tree for the optimal reinsertion target
 *      using branch-and-bound pruning.
 *   3. Sort reinsertions by area improvement, apply non-conflicting ones greedily.
 *   4. Repeat for a configurable number of iterations.
 *
 * On this binned-SAH build it buys ~0.04 % tree SAH (3.5M triangles, 2026-08) for ~430 ms of worker time.
 */
export class ReinsertionOptimizer {

	constructor( traversalCost, intersectionCost ) {

		this.traversalCost = traversalCost;
		this.intersectionCost = intersectionCost;

		// Fraction of total nodes to consider per iteration
		this.batchSizeRatio = 0.02;

		// Maximum optimization iterations
		this.maxIterations = 2;

		// Time budget (ms) — abort if exceeded
		this.timeBudgetMs = 15000;

		// Statistics
		this.stats = { reinsertionsApplied: 0, iterations: 0, timeMs: 0 };

	}

	setBatchSizeRatio( ratio ) {

		this.batchSizeRatio = Math.max( 0.005, Math.min( 0.1, ratio ) );

	}

	setMaxIterations( n ) {

		this.maxIterations = Math.max( 1, Math.min( 5, n ) );

	}

	getStatistics() {

		return { ...this.stats };

	}

	// --- Surface area (half SA) ---

	surfaceArea( node ) {

		const dx = node.maxX - node.minX;
		const dy = node.maxY - node.minY;
		const dz = node.maxZ - node.minZ;
		return dx * dy + dy * dz + dz * dx;

	}

	// --- Parent map: node → { parent, isLeft } ---

	buildParentMap( root ) {

		const map = new Map();
		map.set( root, { parent: null, isLeft: false } );

		const stack = [ root ];
		while ( stack.length > 0 ) {

			const node = stack.pop();
			if ( node.triangleCount > 0 ) continue;

			if ( node.leftChild ) {

				map.set( node.leftChild, { parent: node, isLeft: true } );
				stack.push( node.leftChild );

			}

			if ( node.rightChild ) {

				map.set( node.rightChild, { parent: node, isLeft: false } );
				stack.push( node.rightChild );

			}

		}

		return map;

	}

	// --- Candidate selection: top N nodes by surface area (min-heap) ---

	findCandidates( root, targetCount, parentMap ) {

		// Collect all non-root nodes (skip root itself and its direct children
		// whose reinsertion would require mutating root identity)
		const heap = []; // min-heap by cost (surface area)

		const stack = [ root ];
		while ( stack.length > 0 ) {

			const node = stack.pop();

			if ( node !== root ) {

				const info = parentMap.get( node );
				// Skip direct children of root to avoid root mutation complexity
				if ( info.parent !== root ) {

					const cost = this.surfaceArea( node );

					if ( heap.length < targetCount ) {

						heap.push( { node, cost } );
						if ( heap.length === targetCount ) this._heapify( heap );

					} else if ( cost > heap[ 0 ].cost ) {

						heap[ 0 ] = { node, cost };
						this._siftDown( heap, 0 );

					}

				}

			}

			if ( node.triangleCount === 0 ) {

				if ( node.leftChild ) stack.push( node.leftChild );
				if ( node.rightChild ) stack.push( node.rightChild );

			}

		}

		return heap;

	}

	// Min-heap helpers (smallest cost at index 0)
	_heapify( heap ) {

		for ( let i = ( heap.length >> 1 ) - 1; i >= 0; i -- ) this._siftDown( heap, i );

	}

	_siftDown( heap, i ) {

		const n = heap.length;
		while ( true ) {

			let smallest = i;
			const l = 2 * i + 1;
			const r = 2 * i + 2;
			if ( l < n && heap[ l ].cost < heap[ smallest ].cost ) smallest = l;
			if ( r < n && heap[ r ].cost < heap[ smallest ].cost ) smallest = r;
			if ( smallest === i ) break;
			const tmp = heap[ i ];
			heap[ i ] = heap[ smallest ];
			heap[ smallest ] = tmp;
			i = smallest;

		}

	}

	// --- Find best reinsertion target for a candidate node ---

	findReinsertion( nodeA, root, parentMap ) {

		const aInfo = parentMap.get( nodeA );
		const parentA = aInfo.parent;
		if ( ! parentA ) return null;

		const siblingA = aInfo.isLeft ? parentA.rightChild : parentA.leftChild;

		const nodeArea = this.surfaceArea( nodeA );
		const parentArea = this.surfaceArea( parentA );

		let bestTo = null;
		let bestAreaDiff = 0;

		// areaDiff accumulates the net area savings from removing nodeA
		// along the path from its parent to the current pivot level
		let areaDiff = parentArea;

		// pivotBbox tracks the combined bounds of everything except nodeA
		// along the path from siblingA upward
		let pbMinX = siblingA.minX, pbMinY = siblingA.minY, pbMinZ = siblingA.minZ;
		let pbMaxX = siblingA.maxX, pbMaxY = siblingA.maxY, pbMaxZ = siblingA.maxZ;

		let siblingNode = siblingA;
		let pivotNode = parentA;

		const searchStack = [];

		do {

			// Search sibling subtree at current level
			searchStack.length = 0;
			searchStack.push( areaDiff, siblingNode );

			while ( searchStack.length > 0 ) {

				// Pop node and areaDiff (stored as pairs: [areaDiff, node, areaDiff, node, ...])
				const topNode = searchStack.pop();
				const topAreaDiff = searchStack.pop();

				// Prune: upper bound on improvement can't beat current best
				if ( topAreaDiff - nodeArea <= bestAreaDiff ) continue;

				// Compute merged area if we insert nodeA next to this target
				const mMinX = Math.min( topNode.minX, nodeA.minX );
				const mMinY = Math.min( topNode.minY, nodeA.minY );
				const mMinZ = Math.min( topNode.minZ, nodeA.minZ );
				const mMaxX = Math.max( topNode.maxX, nodeA.maxX );
				const mMaxY = Math.max( topNode.maxY, nodeA.maxY );
				const mMaxZ = Math.max( topNode.maxZ, nodeA.maxZ );
				const mdx = mMaxX - mMinX, mdy = mMaxY - mMinY, mdz = mMaxZ - mMinZ;
				const mergedArea = mdx * mdy + mdy * mdz + mdz * mdx;

				const reinsertArea = topAreaDiff - mergedArea;

				if ( reinsertArea > bestAreaDiff ) {

					bestTo = topNode;
					bestAreaDiff = reinsertArea;

				}

				// Descend into children if inner node
				if ( topNode.triangleCount === 0 && topNode.leftChild && topNode.rightChild ) {

					const childArea = reinsertArea + this.surfaceArea( topNode );
					searchStack.push( childArea, topNode.leftChild );
					searchStack.push( childArea, topNode.rightChild );

				}

			}

			// Move up one level
			const pivotInfo = parentMap.get( pivotNode );
			if ( ! pivotInfo || pivotInfo.parent === null ) break;

			// Update pivot bbox: accumulate sibling bounds at each level above parentA
			if ( pivotNode !== parentA ) {

				pbMinX = Math.min( pbMinX, siblingNode.minX );
				pbMinY = Math.min( pbMinY, siblingNode.minY );
				pbMinZ = Math.min( pbMinZ, siblingNode.minZ );
				pbMaxX = Math.max( pbMaxX, siblingNode.maxX );
				pbMaxY = Math.max( pbMaxY, siblingNode.maxY );
				pbMaxZ = Math.max( pbMaxZ, siblingNode.maxZ );

				const pdx = pbMaxX - pbMinX, pdy = pbMaxY - pbMinY, pdz = pbMaxZ - pbMinZ;
				const pivotBboxArea = pdx * pdy + pdy * pdz + pdz * pdx;
				areaDiff += this.surfaceArea( pivotNode ) - pivotBboxArea;

			}

			// Get sibling of pivot at next ancestor level
			const pivotParent = pivotInfo.parent;
			siblingNode = pivotInfo.isLeft ? pivotParent.rightChild : pivotParent.leftChild;
			pivotNode = pivotParent;

		} while ( parentMap.get( pivotNode ).parent !== null );

		// Reject trivial reinsertions (same position)
		if ( bestTo === siblingA || bestTo === parentA ) return null;

		return bestTo ? { from: nodeA, to: bestTo, areaDiff: bestAreaDiff } : null;

	}

	// --- Conflict detection: nodes involved in a reinsertion ---

	getConflicts( from, to, parentMap ) {

		const aInfo = parentMap.get( from );
		const siblingA = aInfo.isLeft ? aInfo.parent.rightChild : aInfo.parent.leftChild;

		return [
			to,
			from,
			siblingA,
			parentMap.get( to ).parent,
			aInfo.parent
		];

	}

	// --- Perform the actual tree surgery ---

	reinsertNode( nodeA, targetC, parentMap ) {

		const aInfo = parentMap.get( nodeA );
		const parentA = aInfo.parent;
		const siblingA = aInfo.isLeft ? parentA.rightChild : parentA.leftChild;

		const parentAInfo = parentMap.get( parentA );
		const grandparent = parentAInfo.parent;

		const cInfo = parentMap.get( targetC );
		const targetParent = cInfo.parent;

		// Step 1: Remove parentA from grandparent, replace with siblingA
		if ( parentAInfo.isLeft ) {

			grandparent.leftChild = siblingA;

		} else {

			grandparent.rightChild = siblingA;

		}

		// Step 2: Reuse parentA as new parent of (nodeA, targetC)
		parentA.leftChild = nodeA;
		parentA.rightChild = targetC;
		parentA.triangleOffset = 0;
		parentA.triangleCount = 0;
		parentA.minX = Math.min( nodeA.minX, targetC.minX );
		parentA.minY = Math.min( nodeA.minY, targetC.minY );
		parentA.minZ = Math.min( nodeA.minZ, targetC.minZ );
		parentA.maxX = Math.max( nodeA.maxX, targetC.maxX );
		parentA.maxY = Math.max( nodeA.maxY, targetC.maxY );
		parentA.maxZ = Math.max( nodeA.maxZ, targetC.maxZ );

		// Step 3: Place parentA where targetC was
		if ( cInfo.isLeft ) {

			targetParent.leftChild = parentA;

		} else {

			targetParent.rightChild = parentA;

		}

		// Step 4: Update parent map
		parentMap.set( siblingA, { parent: grandparent, isLeft: parentAInfo.isLeft } );
		parentMap.set( parentA, { parent: targetParent, isLeft: cInfo.isLeft } );
		parentMap.set( nodeA, { parent: parentA, isLeft: true } );
		parentMap.set( targetC, { parent: parentA, isLeft: false } );

		// Step 5: Refit bounds from removal point (grandparent) up to root
		this.refitFrom( grandparent, parentMap );

		// Step 6: Refit bounds from insertion point (targetParent) up to root
		this.refitFrom( targetParent, parentMap );

	}

	// --- Refit bounding boxes from a node up to root ---

	refitFrom( node, parentMap ) {

		let current = node;
		while ( current ) {

			if ( current.triangleCount === 0 && current.leftChild && current.rightChild ) {

				const L = current.leftChild;
				const R = current.rightChild;
				current.minX = Math.min( L.minX, R.minX );
				current.minY = Math.min( L.minY, R.minY );
				current.minZ = Math.min( L.minZ, R.minZ );
				current.maxX = Math.max( L.maxX, R.maxX );
				current.maxY = Math.max( L.maxY, R.maxY );
				current.maxZ = Math.max( L.maxZ, R.maxZ );

			}

			const info = parentMap.get( current );
			current = info ? info.parent : null;

		}

	}

	// --- Main entry point ---

	optimizeBVH( root, progressCallback ) {

		const startTime = performance.now();
		this.stats = { reinsertionsApplied: 0, iterations: 0, timeMs: 0 };

		for ( let iter = 0; iter < this.maxIterations; iter ++ ) {

			if ( performance.now() - startTime > this.timeBudgetMs ) break;

			// Rebuild parent map each iteration (tree structure changes)
			const parentMap = this.buildParentMap( root );
			const nodeCount = parentMap.size;
			const targetCount = Math.max( 1, Math.floor( nodeCount * this.batchSizeRatio ) );

			if ( progressCallback ) {

				progressCallback( `Reinsertion iter ${iter + 1}/${this.maxIterations}: selecting ${targetCount} candidates` );

			}

			// Find highest-cost candidates
			const candidates = this.findCandidates( root, targetCount, parentMap );

			// Find best reinsertion for each candidate
			const reinsertions = [];
			for ( let i = 0; i < candidates.length; i ++ ) {

				if ( performance.now() - startTime > this.timeBudgetMs ) break;

				const r = this.findReinsertion( candidates[ i ].node, root, parentMap );
				if ( r && r.areaDiff > 0 ) {

					reinsertions.push( r );

				}

			}

			// Sort by improvement (largest first) and apply greedily
			reinsertions.sort( ( a, b ) => b.areaDiff - a.areaDiff );

			const touched = new Set();
			let applied = 0;

			for ( const r of reinsertions ) {

				const conflicts = this.getConflicts( r.from, r.to, parentMap );
				if ( conflicts.some( n => touched.has( n ) ) ) continue;

				for ( const n of conflicts ) touched.add( n );

				this.reinsertNode( r.from, r.to, parentMap );
				applied ++;

			}

			this.stats.reinsertionsApplied += applied;
			this.stats.iterations = iter + 1;

			if ( progressCallback ) {

				progressCallback( `Reinsertion iter ${iter + 1}: applied ${applied} reinsertions` );

			}

			// No improvements found — tree is already optimal
			if ( applied === 0 ) break;

		}

		this.stats.timeMs = performance.now() - startTime;
		return this.stats;

	}

}
