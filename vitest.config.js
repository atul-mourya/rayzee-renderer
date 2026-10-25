import path from "path";
import { configDefaults, defineConfig } from "vitest/config";

const __dirname = path.resolve();

export default defineConfig( {
	test: {
		globals: true,
		projects: [
			{
				extends: true,
				test: {
					name: 'unit',
					environment: 'node',
					include: [ 'tests/**/*.test.js' ],
					exclude: [ ...configDefaults.exclude, 'tests/gpu/**' ],
				},
			},
			{
				extends: true,
				test: {
					name: 'gpu',
					environment: './tests/gpu/environment.js',
					include: [ 'tests/gpu/**/*.test.js' ],
				},
			},
		],
		coverage: {
			provider: 'v8',
			reporter: [
				[ 'text' ],
				[ 'text-summary' ]
			],
			include: [ 'rayzee/src/**/*.js', 'app/src/lib/**/*.js' ],
			exclude: [
				'**/.DS_Store', '**/*.md',

				// ── Web workers ──
				'rayzee/src/bvh/BVHWorker.js',
				'rayzee/src/bvh/BVHSubtreeWorker.js',
				'rayzee/src/bvh/BVHRefitWorker.js',
				'rayzee/src/bvh/TLASWorker.js',
				'rayzee/src/materials/TexturesWorker.js',
				'rayzee/src/materials/PackWorker.js',
				'rayzee/src/environment/CDFWorker.js',
				'rayzee/src/viewer/picture/AIUpscalerWorker.js',

				// ── GPU-dependent: TSL shaders (require WebGPU runtime) ──
				'rayzee/src/shaders/**',

				// ── GPU-dependent: Pipeline stages (TSL compute shaders, StorageTextures) ──
				'rayzee/src/viewer/picture/AutoExposure.js',
				'rayzee/src/viewer/denoise/MotionVector.js',
				'rayzee/src/viewer/denoise/NormalDepth.js',
				'rayzee/src/viewer/denoise/NRD.js',
				'rayzee/src/pathtracer/PathTracer.js',
				'rayzee/src/pathtracer/PathTracerStage.js',

				// ── GPU-dependent: WebGPU renderer orchestration ──
				'rayzee/src/viewer/PathTracerApp.js',
				'rayzee/src/index.js',

				// ── GPU-dependent: TSL shader graph / WebGPU textures ──
				'rayzee/src/pathtracer/ShaderBuilder.js',
				'rayzee/src/pathtracer/StorageTexturePool.js',
				'rayzee/src/materials/TextureCreator.js',
				'rayzee/src/scene/SceneProcessor.js',
				'rayzee/src/bvh/ParallelBVHBuilder.js',

				// ── GPU-dependent: Asset loading with GPU texture upload ──
				'rayzee/src/loaders/AssetLoader.js',

				// ── GPU-dependent: Managers with deep TSL/WebGPU integration ──
				'rayzee/src/materials/MaterialDataManager.js',
				'rayzee/src/environment/EnvironmentManager.js',
				'rayzee/src/pathtracer/UniformManager.js',
				'rayzee/src/viewer/denoise/DenoisingManager.js',
				'rayzee/src/viewer/animation/VideoRenderManager.js',
				'rayzee/src/viewer/camera/InteractionManager.js',
				'rayzee/src/viewer/overlays/OutlineHelper.js',

				// ── GPU-dependent: Denoiser passes (oidn-web GPU pipeline) ──
				'rayzee/src/viewer/denoise/OIDNDenoiser.js',
				'rayzee/src/viewer/denoise/OIDNTemporalHistory.js',
				'rayzee/src/viewer/picture/AIUpscaler.js',
			],
		},
	},
	resolve: {
		alias: {
			// Match app/vite.config.js. Without this, `import ... from 'rayzee'` resolves through
			// node_modules to the prebuilt dist bundle, so tests silently exercise the last build
			// instead of the working tree.
			"rayzee": path.resolve( __dirname, "rayzee/src/index.js" ),
			"@/core": path.resolve( __dirname, "rayzee/src" ),
			"@": path.resolve( __dirname, "app/src" ),
			"oidn-web/dist/oidn.js": path.resolve( __dirname, "tests/__mocks__/oidn-web.js" ),
			"oidn-web": path.resolve( __dirname, "tests/__mocks__/oidn-web.js" ),
		},
	},
} );
