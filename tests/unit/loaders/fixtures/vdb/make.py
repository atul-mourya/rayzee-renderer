# Writes the .vdb fixtures and, beside each, what OpenVDB reads back (<name>-openvdb.json): every grid's type, class,
# index-to-world matrix and active box, and of the voxels in that box that are not the background, their count, sum,
# a sum weighed by position ( ( 7i + 13j + 31k ) mod 97 / 97, i j k from the box's corner ) and a sample.
# Blender 5.1 ships OpenVDB 13 as a module:
#   /Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python make.py
import json, math, os, random
import numpy as np
import openvdb as vdb

here = os.path.dirname( os.path.abspath( __file__ ) )
rng = random.Random( 7 )


def sparse( grid, count, lo, hi ):
    acc = grid.getAccessor()
    for _ in range( count ):
        ijk = tuple( rng.randint( lo, hi ) for _ in range( 3 ) )
        acc.setValueOn( ijk, rng.uniform( 0.05, 4.0 ) )
    return grid


def fog( name, values = 300, transform = None ):
    g = vdb.FloatGrid()
    g.name = name
    g.gridClass = vdb.GridClass.FOG_VOLUME
    sparse( g, values, -20, 20 )
    # A whole 8³ leaf and a 16³ block filled: tiles where a node is filled whole, once pruned.
    g.fill( ( 24, 0, 0 ), ( 31, 7, 7 ), 1.5, True )
    g.fill( ( -32, -16, 0 ), ( -17, -1, 15 ), 0.75, True )
    g.prune()
    if transform is not None:
        g.transform = transform
    return g


def expected( path ):
    out = []
    for g in vdb.readAll( path )[ 0 ]:
        entry = { 'name': g.name, 'type': g.valueTypeName, 'class': str( g.gridClass ) }
        m = g.transform.indexToWorld
        entry[ 'indexToWorld' ] = [ list( g.transform.indexToWorld( ( 1, 0, 0 ) ) ), list( g.transform.indexToWorld( ( 0, 1, 0 ) ) ),
            list( g.transform.indexToWorld( ( 0, 0, 1 ) ) ), list( g.transform.indexToWorld( ( 0, 0, 0 ) ) ) ]
        if g.valueTypeName in ( 'float', 'double' ) and g.activeVoxelCount() == 0:
            entry[ 'count' ] = 0
        elif g.valueTypeName in ( 'float', 'double' ):
            lo, hi = g.evalActiveVoxelBoundingBox()
            entry[ 'box' ] = [ list( lo ), list( hi ) ]
            size = tuple( hi[ k ] - lo[ k ] + 1 for k in range( 3 ) )
            a = np.zeros( size, dtype = np.float64 if g.valueTypeName == 'double' else np.float32 )
            g.copyToArray( a, ijk = lo )
            nz = np.argwhere( a != g.background )
            values = [ float( a[ i, j, k ] ) for i, j, k in nz ]
            entry[ 'count' ] = len( values )
            entry[ 'sum' ] = sum( values )
            entry[ 'weighted' ] = sum( v * ( ( 7 * i + 13 * j + 31 * k ) % 97 ) / 97 for v, ( i, j, k ) in zip( values, nz ) )
            entry[ 'sample' ] = [ [ int( i ), int( j ), int( k ), values[ n ] ] for n, ( i, j, k ) in enumerate( nz ) if n % max( 1, len( values ) // 48 ) == 0 ]
        out.append( entry )
    with open( path.replace( '.vdb', '-openvdb.json' ), 'w' ) as f:
        json.dump( out, f )


def write( name, grids ):
    path = os.path.join( here, name + '.vdb' )
    vdb.write( path, grids )
    expected( path )


write( 'fog', [ fog( 'density' ) ] )

half = fog( 'density' )
half.saveFloatAsHalf = True
write( 'half', [ half ] )

turned = vdb.createLinearTransform( [ [ 0.1 * math.cos( 0.5 ), 0.1 * math.sin( 0.5 ), 0, 0 ], [ -0.1 * math.sin( 0.5 ), 0.1 * math.cos( 0.5 ), 0, 0 ],
    [ 0, 0, 0.2, 0 ], [ 1.5, -2, 0.25, 1 ] ] )
write( 'affine', [ fog( 'density', transform = turned ) ] )

# Several grids: a temperature beside the density, a vector grid to step over, and a double grid.
scaled = vdb.createLinearTransform( voxelSize = 0.05 )
temperature = fog( 'temperature', 120, scaled )
velocity = vdb.Vec3SGrid()
velocity.name = 'vel'
velocity.getAccessor().setValueOn( ( 1, 2, 3 ), ( 1, 0, 0 ) )
dense = vdb.DoubleGrid()
dense.name = 'flame'
sparse( dense, 80, -6, 6 )
write( 'grids', [ fog( 'density', 200, scaled ), velocity, temperature, dense ] )

# Inactive voxels of other values than the background: the node flags that store one, two or many of them.
mixed = vdb.FloatGrid()
mixed.name = 'mixed'
acc = mixed.getAccessor()
for x in range( 8 ):
    for y in range( 8 ):
        for z in range( 8 ):
            acc.setValueOn( ( x, y, z ), 1 + x )
for z in range( 8 ):
    acc.setValueOff( ( 0, 0, z ), 2.5 )
for z in range( 8 ):
    acc.setValueOn( ( 8 + z, 0, 0 ), 3 )
    acc.setValueOff( ( 8 + z, 1, 0 ), 2.5 if z % 2 else 6 )
for z in range( 8 ):
    acc.setValueOn( ( 16, 0, z ), 1 )
    acc.setValueOff( ( 16, 1, z ), z * 0.5 + 0.1 )
write( 'mixed', [ mixed ] )

# seq_0001 … seq_0004: a ball of fog that moves, then grows past the room its volume's slot keeps (a sequence).
for frame, ( radius, x ) in enumerate( [ ( 3, 0 ), ( 3, 4 ), ( 4, 8 ), ( 9, 10 ) ], start = 1 ):
    ball = vdb.FloatGrid()
    ball.name = 'density'
    ball.gridClass = vdb.GridClass.FOG_VOLUME
    acc = ball.getAccessor()
    for i in range( -radius, radius + 1 ):
        for j in range( -radius, radius + 1 ):
            for k in range( -radius, radius + 1 ):
                d = math.sqrt( i * i + j * j + k * k ) / radius
                if d < 1:
                    acc.setValueOn( ( x + i, j, k ), 1 - d )
    ball.transform = vdb.createLinearTransform( voxelSize = 0.1 )
    write( 'seq_%04d' % frame, [ ball ] )

# fire_0001 … fire_0003: EmberGen's shape of file: temperature and flames, no density, half floats, the first frame
# empty, rising along Z from index 0, temperature peaking near 1.25.
for frame, height in enumerate( [ 0, 4, 12 ], start = 1 ):
    grids = []
    for name, peak in ( ( 'temperature', 1.25 ), ( 'flames', 1.0 ) ):
        g = vdb.FloatGrid()
        g.name = name
        g.gridClass = vdb.GridClass.FOG_VOLUME
        g.saveFloatAsHalf = True
        acc = g.getAccessor()
        for i in range( -3, 4 ):
            for j in range( -3, 4 ):
                for k in range( height ):
                    d = math.sqrt( i * i + j * j ) / 3.5
                    if d < 1:
                        acc.setValueOn( ( i, j, k ), peak * ( 1 - d ) * ( 1 - 0.5 * k / height ) )
        g.transform = vdb.createLinearTransform( voxelSize = 0.1 )
        grids.append( g )
    write( 'fire_%04d' % frame, grids )

# mantaflow.vdb: frame 24 of a Blender 5.1 smoke-and-fire bake (a 48³ domain, OpenVDB cache, ZIP, half floats), as written.
if os.path.exists( os.path.join( here, 'mantaflow.vdb' ) ):
    expected( os.path.join( here, 'mantaflow.vdb' ) )
print( 'WROTE', sorted( f for f in os.listdir( here ) if f.endswith( '.vdb' ) ) )
