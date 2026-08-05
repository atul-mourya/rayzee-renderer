// No external dependencies — uses inline float fields for bounds (no Vector3)

/**
 * Treelet optimization for BVH trees (Bittner et al. 2013).
 *
 * For each small subtree ("treelet") of N leaves, enumerates all
 * Catalan(N-1) distinct binary tree topologies, tries all leaf
 * permutations (or greedy assignment for N > 5), and replaces the
 * subtree with the arrangement that minimises SAH cost.
 */
export class TreeletOptimizer {

	constructor( traversalCost, intersectionCost ) {

		this.traversalCost = traversalCost;
		this.intersectionCost = intersectionCost;
		this.maxTreeletLeaves = 7;
		this.minImprovement = 0.02; // relative improvement threshold

		// Precompute topologies for leaf counts 3..maxTreeletLeaves
		this.topologyCache = new Map();
		for ( let n = 3; n <= this.maxTreeletLeaves; n ++ ) {

			this.topologyCache.set( n, this.generateTopologies( n ) );

		}

		// Stats
		this.stats = {
			treeletsProcessed: 0,
			treeletsImproved: 0,
			totalSAHImprovement: 0,
			averageSAHImprovement: 0,
			optimizationTime: 0
		};

	}

	// ------------------------------------------------------------------
	// Topology generation — nested binary trees via Catalan decomposition
	// ------------------------------------------------------------------

	/**
	 * Generate all distinct binary tree topologies for `n` leaves.
	 * Leaves are represented as integers 0..n-1 (slot indices).
	 * Internal nodes are 2-element arrays [left, right].
	 *
	 * Examples for n=3 (Catalan(2)=2):
	 *   [[0,1],2]   and   [0,[1,2]]
	 */
	generateTopologies( n ) {

		if ( n === 1 ) return [ 0 ];
		if ( n === 2 ) return [[ 0, 1 ]];

		const results = [];

		// Split n leaves into left (k) and right (n-k) groups.
		// Base cases return arrays of topologies:
		//   n=1 → [0]        (one topology: leaf 0)
		//   n=2 → [[0,1]]    (one topology: pair [0,1])
		// So `for (const t of topos)` yields individual topologies in all cases.
		for ( let k = 1; k < n; k ++ ) {

			const leftTopos = this.generateTopologies( k );
			const rightTopos = this.generateTopologies( n - k );

			for ( const lt of leftTopos ) {

				for ( const rt of rightTopos ) {

					results.push( [ lt, this.offsetTopology( rt, k ) ] );

				}

			}

		}

		return results;

	}

	/**
	 * Offset all leaf indices in a topology by `offset`.
	 */
	offsetTopology( topo, offset ) {

		if ( typeof topo === 'number' ) return topo + offset;
		return [ this.offsetTopology( topo[ 0 ], offset ), this.offsetTopology( topo[ 1 ], offset ) ];

	}

	// ------------------------------------------------------------------
	// Main entry point
	// ------------------------------------------------------------------

	optimizeBVH( bvhRoot ) {

		const startTime = performance.now();
		const maxTime = 30000; // 30s safety timeout

		this.stats = {
			treeletsProcessed: 0,
			treeletsImproved: 0,
			totalSAHImprovement: 0,
			averageSAHImprovement: 0,
			optimizationTime: 0
		};

		// Identify all treelet roots (bottom-up, non-overlapping)
		const treeletRoots = this.identifyTreeletRoots( bvhRoot );

		for ( let i = 0; i < treeletRoots.length; i ++ ) {

			if ( performance.now() - startTime > maxTime ) {

				console.warn( `TreeletOptimizer: timeout after ${i}/${treeletRoots.length} treelets` );
				break;

			}

			this.optimizeTreelet( treeletRoots[ i ] );

		}

		this.stats.optimizationTime = performance.now() - startTime;
		this.stats.averageSAHImprovement = this.stats.treeletsProcessed > 0
			? this.stats.totalSAHImprovement / this.stats.treeletsProcessed
			: 0;

		return bvhRoot;

	}

	// ------------------------------------------------------------------
	// Treelet identification — bottom-up, non-overlapping
	// ------------------------------------------------------------------

	identifyTreeletRoots( bvhRoot ) {

		const roots = [];
		const processed = new Set();

		// Post-order traversal: children before parents so we process
		// bottom-up and skip subtrees already covered by a deeper treelet.
		const stack = [ { node: bvhRoot, visited: false } ];

		while ( stack.length > 0 ) {

			const top = stack[ stack.length - 1 ];

			if ( top.visited ) {

				stack.pop();
				const node = top.node;

				// Skip leaves
				if ( node.triangleCount > 0 ) continue;
				// Skip if already inside a processed treelet
				if ( processed.has( node ) ) continue;

				const leafCount = this.countLeaves( node );
				if ( leafCount >= 3 && leafCount <= this.maxTreeletLeaves ) {

					roots.push( node );
					this.markSubtree( node, processed );

				}

			} else {

				top.visited = true;
				const node = top.node;
				if ( node.triangleCount > 0 ) continue;
				if ( node.rightChild ) stack.push( { node: node.rightChild, visited: false } );
				if ( node.leftChild ) stack.push( { node: node.leftChild, visited: false } );

			}

		}

		return roots;

	}

	countLeaves( node ) {

		if ( ! node ) return 0;
		if ( node.triangleCount > 0 ) return 1;
		return this.countLeaves( node.leftChild ) + this.countLeaves( node.rightChild );

	}

	markSubtree( node, set ) {

		if ( ! node ) return;
		set.add( node );
		if ( node.triangleCount > 0 ) return;
		this.markSubtree( node.leftChild, set );
		this.markSubtree( node.rightChild, set );

	}

	// ------------------------------------------------------------------
	// Single treelet optimization
	// ------------------------------------------------------------------

	optimizeTreelet( treeletRoot ) {

		// Extract leaves
		const leaves = [];
		this.extractLeaves( treeletRoot, leaves );
		const n = leaves.length;

		if ( n < 3 || n > this.maxTreeletLeaves ) return;

		this.stats.treeletsProcessed ++;

		const originalCost = this.evaluateSubtreeSAH( treeletRoot );
		const topologies = this.topologyCache.get( n );
		if ( ! topologies || topologies.length === 0 ) return;

		let bestCost = originalCost;
		let bestTopo = null;
		let bestPerm = null;

		if ( n <= 5 ) {

			// Full permutation search — feasible for n<=5 (max 120 perms × 14 topos)
			const perms = this.generatePermutations( n );

			for ( const topo of topologies ) {

				for ( const perm of perms ) {

					const cost = this.evaluateTopology( topo, leaves, perm );
					if ( cost < bestCost ) {

						bestCost = cost;
						bestTopo = topo;
						bestPerm = perm;

					}

				}

			}

		} else {

			// Greedy assignment for n>5: for each topology, use identity perm
			// plus a few SAH-guided swaps
			const identityPerm = Array.from( { length: n }, ( _, i ) => i );

			for ( const topo of topologies ) {

				// Try identity permutation
				const cost = this.evaluateTopology( topo, leaves, identityPerm );
				if ( cost < bestCost ) {

					bestCost = cost;
					bestTopo = topo;
					bestPerm = identityPerm;

				}

				// Try greedy swap improvements
				const result = this.greedySwapOptimize( topo, leaves, identityPerm, cost );
				if ( result.cost < bestCost ) {

					bestCost = result.cost;
					bestTopo = topo;
					bestPerm = result.perm;

				}

			}

		}

		// Apply if relative improvement exceeds threshold
		const relativeImprovement = ( originalCost - bestCost ) / originalCost;
		if ( bestTopo && relativeImprovement > this.minImprovement ) {

			this.reconstructTreelet( treeletRoot, bestTopo, leaves, bestPerm );
			this.stats.treeletsImproved ++;
			this.stats.totalSAHImprovement += relativeImprovement;

		}

	}

	extractLeaves( node, leaves ) {

		if ( ! node ) return;

		if ( node.triangleCount > 0 ) {

			// BVHNode uses inline floats (minX/maxX etc.)
			leaves.push( {
				minX: node.minX, minY: node.minY, minZ: node.minZ,
				maxX: node.maxX, maxY: node.maxY, maxZ: node.maxZ,
				triangleOffset: node.triangleOffset,
				triangleCount: node.triangleCount
			} );
			return;

		}

		this.extractLeaves( node.leftChild, leaves );
		this.extractLeaves( node.rightChild, leaves );

	}

	// ------------------------------------------------------------------
	// SAH evaluation
	// ------------------------------------------------------------------

	evaluateSubtreeSAH( node ) {

		if ( ! node ) return 0;

		if ( node.triangleCount > 0 ) {

			return this.surfaceAreaFlat( node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ ) * node.triangleCount * this.intersectionCost;

		}

		const leftCost = this.evaluateSubtreeSAH( node.leftChild );
		const rightCost = this.evaluateSubtreeSAH( node.rightChild );
		const sa = this.surfaceAreaFlat( node.minX, node.minY, node.minZ, node.maxX, node.maxY, node.maxZ );
		return sa * this.traversalCost + leftCost + rightCost;

	}

	/**
	 * Evaluate SAH cost for a topology with a given leaf permutation.
	 * Returns { cost, boundsMin, boundsMax } for internal use, or just cost number.
	 */
	evaluateTopology( topo, leaves, perm ) {

		const result = this.evalTopoRecursive( topo, leaves, perm );
		return result.cost;

	}

	evalTopoRecursive( topo, leaves, perm ) {

		if ( typeof topo === 'number' ) {

			// Leaf slot — look up actual leaf via permutation
			const leaf = leaves[ perm[ topo ] ];
			return {
				cost: this.surfaceAreaFlat( leaf.minX, leaf.minY, leaf.minZ, leaf.maxX, leaf.maxY, leaf.maxZ ) * leaf.triangleCount * this.intersectionCost,
				minX: leaf.minX, minY: leaf.minY, minZ: leaf.minZ,
				maxX: leaf.maxX, maxY: leaf.maxY, maxZ: leaf.maxZ
			};

		}

		const left = this.evalTopoRecursive( topo[ 0 ], leaves, perm );
		const right = this.evalTopoRecursive( topo[ 1 ], leaves, perm );

		const mnX = Math.min( left.minX, right.minX );
		const mnY = Math.min( left.minY, right.minY );
		const mnZ = Math.min( left.minZ, right.minZ );
		const mxX = Math.max( left.maxX, right.maxX );
		const mxY = Math.max( left.maxY, right.maxY );
		const mxZ = Math.max( left.maxZ, right.maxZ );

		const sa = this.surfaceAreaFlat( mnX, mnY, mnZ, mxX, mxY, mxZ );
		return {
			cost: sa * this.traversalCost + left.cost + right.cost,
			minX: mnX, minY: mnY, minZ: mnZ,
			maxX: mxX, maxY: mxY, maxZ: mxZ
		};

	}

	surfaceAreaFlat( minX, minY, minZ, maxX, maxY, maxZ ) {

		const dx = maxX - minX;
		const dy = maxY - minY;
		const dz = maxZ - minZ;
		return 2 * ( dx * dy + dy * dz + dz * dx );

	}

	// ------------------------------------------------------------------
	// Permutation helpers
	// ------------------------------------------------------------------

	generatePermutations( n ) {

		const result = [];
		const arr = Array.from( { length: n }, ( _, i ) => i );

		const permute = ( start ) => {

			if ( start === n ) {

				result.push( [ ...arr ] );
				return;

			}

			for ( let i = start; i < n; i ++ ) {

				[ arr[ start ], arr[ i ] ] = [ arr[ i ], arr[ start ] ];
				permute( start + 1 );
				[ arr[ start ], arr[ i ] ] = [ arr[ i ], arr[ start ] ];

			}

		};

		permute( 0 );
		return result;

	}

	/**
	 * Greedy pairwise swap optimization for large treelet sizes.
	 * Starting from an initial permutation, try all pairwise swaps
	 * and accept any that improve cost. Repeat until no improvement.
	 */
	greedySwapOptimize( topo, leaves, initialPerm, initialCost ) {

		const perm = [ ...initialPerm ];
		let cost = initialCost;
		let improved = true;

		while ( improved ) {

			improved = false;

			for ( let i = 0; i < perm.length - 1; i ++ ) {

				for ( let j = i + 1; j < perm.length; j ++ ) {

					// Swap
					[ perm[ i ], perm[ j ] ] = [ perm[ j ], perm[ i ] ];
					const newCost = this.evaluateTopology( topo, leaves, perm );

					if ( newCost < cost ) {

						cost = newCost;
						improved = true;

					} else {

						// Swap back
						[ perm[ i ], perm[ j ] ] = [ perm[ j ], perm[ i ] ];

					}

				}

			}

		}

		return { perm, cost };

	}

	// ------------------------------------------------------------------
	// Reconstruction — builds proper BVHNode instances
	// ------------------------------------------------------------------

	reconstructTreelet( treeletRoot, topo, leaves, perm ) {

		const built = this.buildSubtree( topo, leaves, perm );

		// Copy built structure into the existing treelet root node (inline floats)
		treeletRoot.minX = built.minX; treeletRoot.minY = built.minY; treeletRoot.minZ = built.minZ;
		treeletRoot.maxX = built.maxX; treeletRoot.maxY = built.maxY; treeletRoot.maxZ = built.maxZ;
		treeletRoot.leftChild = built.leftChild;
		treeletRoot.rightChild = built.rightChild;
		treeletRoot.triangleOffset = built.triangleOffset;
		treeletRoot.triangleCount = built.triangleCount;

	}

	/**
	 * Recursively build a BVHNode subtree from a topology + leaf permutation.
	 */
	buildSubtree( topo, leaves, perm ) {

		if ( typeof topo === 'number' ) {

			// Leaf — create a lightweight node with inline bounds
			const leaf = leaves[ perm[ topo ] ];
			const node = new TreeletBVHNode();
			node.minX = leaf.minX; node.minY = leaf.minY; node.minZ = leaf.minZ;
			node.maxX = leaf.maxX; node.maxY = leaf.maxY; node.maxZ = leaf.maxZ;
			node.triangleOffset = leaf.triangleOffset;
			node.triangleCount = leaf.triangleCount;
			return node;

		}

		const left = this.buildSubtree( topo[ 0 ], leaves, perm );
		const right = this.buildSubtree( topo[ 1 ], leaves, perm );

		const node = new TreeletBVHNode();
		node.leftChild = left;
		node.rightChild = right;
		node.minX = Math.min( left.minX, right.minX );
		node.minY = Math.min( left.minY, right.minY );
		node.minZ = Math.min( left.minZ, right.minZ );
		node.maxX = Math.max( left.maxX, right.maxX );
		node.maxY = Math.max( left.maxY, right.maxY );
		node.maxZ = Math.max( left.maxZ, right.maxZ );

		return node;

	}

	// ------------------------------------------------------------------
	// Configuration
	// ------------------------------------------------------------------

	setTreeletSize( size ) {

		this.maxTreeletLeaves = Math.max( 3, Math.min( 7, size ) );

		// Regenerate topology cache if needed
		for ( let n = 3; n <= this.maxTreeletLeaves; n ++ ) {

			if ( ! this.topologyCache.has( n ) ) {

				this.topologyCache.set( n, this.generateTopologies( n ) );

			}

		}

	}

	setMinImprovement( threshold ) {

		this.minImprovement = Math.max( 0.001, threshold );

	}

	getStatistics() {

		return { ...this.stats };

	}

}

/**
 * Lightweight BVH node used during reconstruction.
 * Duck-type compatible with the main BVHNode class —
 * uses inline float fields (minX/maxX etc.).
 */
class TreeletBVHNode {

	constructor() {

		this.minX = 0; this.minY = 0; this.minZ = 0;
		this.maxX = 0; this.maxY = 0; this.maxZ = 0;
		this.leftChild = null;
		this.rightChild = null;
		this.triangleOffset = 0;
		this.triangleCount = 0;

	}

}
