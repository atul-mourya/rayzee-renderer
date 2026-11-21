// NanoVDB fixtures written by OpenVDB's nanovdb (ABI 32.11, header-only; its files start "NanoVDB2", its grids
// "NanoVDB1"), each with a JSON of what nanovdb reads back: metadata and getValue at seeded coordinates. A fog sphere
// (negative coordinates, constant tiles inside) as every scalar type, Zip; a smaller one as a raw grid buffer.
// (createFogVolumeSphere leaves the level set's background, 1.5, at the root; its nodes hold 0 outside the sphere.)
//   clang++ -std=c++17 -ffp-contract=off -I openvdb/nanovdb -DNANOVDB_USE_ZIP make.cpp -lz -o make && ./make .
// -ffp-contract=off: a quantised value is code × step + minimum in two roundings, as written, not one fused.
#include <nanovdb/NanoVDB.h>
#include <nanovdb/io/IO.h>
#include <nanovdb/tools/CreatePrimitives.h>
#include <nanovdb/tools/CreateNanoGrid.h>
#include <cstdio>
#include <string>
#include <vector>
using namespace nanovdb;
static float asFloat(float v) { return v; }
static double asFloat(double v) { return v; }
static float asFloat(Half v) { return math::HalfToFloat(v.raw); }
template<typename BuildT>
static void dump(FILE *out, const NanoGrid<BuildT> *grid, int n, bool comma) {
    auto box = grid->indexBBox();
    auto acc = grid->getAccessor();
    auto &m = grid->map();
    char type[64];
    fprintf(out, "\"%s\":{\"type\":\"%s\",\"class\":%u,\"voxels\":%llu,\"min\":[%d,%d,%d],\"max\":[%d,%d,%d],\"matrix\":[", grid->gridName(), toStr(type, grid->gridType()),
            unsigned(grid->gridClass()), (unsigned long long)grid->activeVoxelCount(), box.min()[0], box.min()[1], box.min()[2], box.max()[0], box.max()[1], box.max()[2]);
    for (int i = 0; i < 9; i++) fprintf(out, "%.17g,", m.mMatD[i]);
    fprintf(out, "%.17g,%.17g,%.17g],\"background\":%.17g,\"values\":[", m.mVecD[0], m.mVecD[1], m.mVecD[2], double(asFloat(grid->tree().background())));
    uint32_t s = 777;
    auto next = [&]() { s = s * 1664525u + 1013904223u; return s >> 8; };
    for (int i = 0; i < n; i++) {
        Coord c;
        for (int a = 0; a < 3; a++) { int lo = box.min()[a] - 1, span = box.max()[a] - box.min()[a] + 3; c[a] = lo + int(next() % span); }
        fprintf(out, "%s[%d,%d,%d,%.17g]", i ? "," : "", c[0], c[1], c[2], double(asFloat(acc.getValue(c))));
    }
    fprintf(out, "]}%s\n", comma ? "," : "");
}
template<typename BuildT>
static GridHandle<HostBuffer> sphere(const char *name, double radius, Vec3d centre = Vec3d(-1.5, 2.0, 0.25)) {
    return tools::createFogVolumeSphere<BuildT>(radius, centre, 0.5, 3.0, Vec3d(0.1, -0.2, 0.3), name);
}
int main(int argc, char **argv) {
    const std::string dir = argv[1];
    std::vector<GridHandle<HostBuffer>> types;
    types.push_back(sphere<float>("float", 10.0));
    types.push_back(sphere<double>("double", 10.0));
    auto half = tools::createNanoGrid<NanoGrid<float>, Half>(*types[0].grid<float>());
    reinterpret_cast<GridData*>(half.data())->setGridName("half");
    types.push_back(std::move(half));
    types.push_back(sphere<Fp4>("fp4", 10.0));
    types.push_back(sphere<Fp8>("fp8", 10.0));
    types.push_back(sphere<Fp16>("fp16", 10.0));
    types.push_back(sphere<FpN>("fpN", 10.0));
    io::writeGrids(dir + "/types-zip.nvdb", types, io::Codec::ZIP);
    FILE *json = fopen((dir + "/types-zip-nanovdb.json").c_str(), "w");
    fprintf(json, "{\n");
    dump(json, types[0].grid<float>(), 400, true);
    dump(json, types[1].grid<double>(), 200, true);
    dump(json, types[2].grid<Half>(), 200, true);
    dump(json, types[3].grid<Fp4>(), 200, true);
    dump(json, types[4].grid<Fp8>(), 200, true);
    dump(json, types[5].grid<Fp16>(), 200, true);
    dump(json, types[6].grid<FpN>(), 400, false);
    fprintf(json, "}\n");
    fclose(json);
    // In one upper node (positive indices): a raw buffer is stored as it is in memory, 270 KB an upper node.
    auto raw = sphere<float>("density", 3.0, Vec3d(8.0, 8.0, 8.0));
    raw.write(dir + "/density-raw.nvdb");
    json = fopen((dir + "/density-raw-nanovdb.json").c_str(), "w");
    fprintf(json, "{\n");
    dump(json, raw.grid<float>(), 300, false);
    fprintf(json, "}\n");
    fclose(json);
    return 0;
}
