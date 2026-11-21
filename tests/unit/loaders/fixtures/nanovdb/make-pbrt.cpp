// The NanoVDB fixture, written by nanovdb itself (pbrt-v4's copy, ABI 32.3): a fog sphere (negative coordinates,
// constant tiles inside) and a temperature box, Zip, one segment. Prints, as JSON, what nanovdb reads back: metadata and
// getValue at seeded coordinates.
//   clang++ -std=c++17 -I pbrt-v4/src/ext/openvdb/nanovdb -DNANOVDB_USE_ZIP make-pbrt.cpp -lz -o make-pbrt
//   ./make-pbrt . > fog-zip-nanovdb.json
#include <nanovdb/NanoVDB.h>
#include <nanovdb/util/IO.h>
#include <nanovdb/util/GridBuilder.h>
#include <nanovdb/util/Primitives.h>
#include <cstdio>
#include <vector>
using namespace nanovdb;
static void dump(const NanoGrid<float> *grid, const char *name, int n, bool comma) {
    auto box = grid->indexBBox();
    auto acc = grid->getAccessor();
    auto &m = grid->map();
    printf("\"%s\":{\"voxels\":%llu,\"min\":[%d,%d,%d],\"max\":[%d,%d,%d],\"matrix\":[", name, (unsigned long long)grid->activeVoxelCount(),
           box.min()[0], box.min()[1], box.min()[2], box.max()[0], box.max()[1], box.max()[2]);
    for (int i = 0; i < 9; i++) printf("%.17g,", m.mMatD[i]);
    printf("%.17g,%.17g,%.17g],\"lowerTiles\":%u,\"values\":[", m.mVecD[0], m.mVecD[1], m.mVecD[2], grid->tree().nodeCount(1) ? reinterpret_cast<const TreeData<3>*>(&grid->tree())->mTileCount[0] : 0);
    uint32_t s = 777;
    auto next = [&]() { s = s * 1664525u + 1013904223u; return s >> 8; };
    for (int i = 0; i < n; i++) {
        Coord c;
        for (int a = 0; a < 3; a++) { int lo = box.min()[a] - 1, span = box.max()[a] - box.min()[a] + 3; c[a] = lo + int(next() % span); }
        printf("%s[%d,%d,%d,%.9g]", i ? "," : "", c[0], c[1], c[2], acc.getValue(c));
    }
    printf("]}%s\n", comma ? "," : "");
}
int main(int argc, char **argv) {
    auto sphere = createFogVolumeSphere<float>(10.0f, Vec3f(-1.5f, 2.0f, 0.25f), 0.5, 3.0, Vec3d(0.1, -0.2, 0.3), "density");
    GridBuilder<float> builder(0.0f);
    auto acc = builder.getAccessor();
    for (int i = -6; i <= 9; i++) for (int j = -3; j <= 12; j++) for (int k = -8; k <= 5; k++)
        acc.setValue(Coord(i, j, k), 3.0f + 0.25f * i + 0.1f * j * j - 0.05f * k);
    auto box = builder.getHandle<>(0.5, Vec3d(0.1, -0.2, 0.3), "temperature", GridClass::FogVolume);
    std::vector<GridHandle<HostBuffer>> both;
    both.push_back(std::move(sphere));
    both.push_back(std::move(box));
    io::writeGrids(std::string(argv[1]) + "/fog-zip.nvdb", both, io::Codec::ZIP);
    printf("{\n");
    dump(both[0].grid<float>(), "density", 600, true);
    dump(both[1].grid<float>(), "temperature", 300, false);
    printf("}\n");
    return 0;
}
