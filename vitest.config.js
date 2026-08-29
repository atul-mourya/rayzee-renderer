import path from "path";
import { defineConfig } from "vitest/config";

const __dirname = path.resolve();

export default defineConfig( {
	test: {
		globals: true,
		environment: 'node',
		include: [ 'tests/**/*.test.js' ],
		coverage: {
			provider: 'v8',
			reporter: [
				[ 'text' ],
				[ 'text-summary' ]
			],
			include: [ 'rayzee/src/**/*.js', 'app/src/lib/**/*.js' ],
			exclude: [
				'**/.DS_Store', '**/*.md', '**/Workers/**',

				// ── GPU-dependent: TSL shaders (require WebGPU runtime) ──
				'rayzee/src/TSL/**',

				// ── GPU-dependent: Pipeline stages (TSL compute shaders, StorageTextures) ──
				'rayzee/src/Stages/ASVGF.js',
				'rayzee/src/Stages/AdaptiveSampling.js',
				'rayzee/src/Stages/AutoExposure.js',
				'rayzee/src/Stages/BilateralFilter.js',
				'rayzee/src/Stages/Display.js',
				'rayzee/src/Stages/EdgeFilter.js',
				'rayzee/src/Stages/MotionVector.js',
				'rayzee/src/Stages/NormalDepth.js',
				'rayzee/src/Stages/PathTracer.js',
				'rayzee/src/Stages/PathTracerStage.js',
				'rayzee/src/Stages/Variance.js',

				// ── GPU-dependent: WebGPU renderer orchestration ──
				'rayzee/src/PathTracerApp.js',
				'rayzee/src/index.js',

				// ── GPU-dependent: TSL shader graph / WebGPU textures ──
				'rayzee/src/Processor/ShaderBuilder.js',
				'rayzee/src/Processor/StorageTexturePool.js',
				'rayzee/src/Processor/TextureCreator.js',
				'rayzee/src/Processor/createRenderTargetHelper.js',
				'rayzee/src/Processor/SceneProcessor.js',
				'rayzee/src/Processor/parallelBVHBuilder.js',
				'rayzee/src/Processor/generateMaterialSpheres.js',

				// ── GPU-dependent: Asset loading with GPU texture upload ──
				'rayzee/src/Processor/AssetLoader.js',

				// ── GPU-dependent: Managers with deep TSL/WebGPU integration ──
				'rayzee/src/managers/MaterialDataManager.js',
				'rayzee/src/managers/EnvironmentManager.js',
				'rayzee/src/managers/UniformManager.js',
				'rayzee/src/managers/DenoisingManager.js',
				'rayzee/src/managers/VideoRenderManager.js',
				'rayzee/src/managers/InteractionManager.js',
				'rayzee/src/managers/helpers/OutlineHelper.js',

				// ── GPU-dependent: Denoiser passes (oidn-web GPU pipeline) ──
				'rayzee/src/Passes/**',
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
			"oidn-web": path.resolve( __dirname, "tests/__mocks__/oidn-web.js" ),
		},
	},
} );
