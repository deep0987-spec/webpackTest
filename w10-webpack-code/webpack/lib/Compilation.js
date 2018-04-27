/*
	MIT License http://www.opensource.org/licenses/mit-license.php
	Author Tobias Koppers @sokra
	*/
"use strict";

const asyncLib = require("async");
const crypto = require("crypto");
// 核心库 tapable
const Tapable = require("tapable");

const EntryModuleNotFoundError = require("./EntryModuleNotFoundError");
const ModuleNotFoundError = require("./ModuleNotFoundError");
const ModuleDependencyWarning = require("./ModuleDependencyWarning");
const ModuleDependencyError = require("./ModuleDependencyError");
const Module = require("./Module");
const Chunk = require("./Chunk");
const Entrypoint = require("./Entrypoint");
const MainTemplate = require("./MainTemplate");
const ChunkTemplate = require("./ChunkTemplate");
const HotUpdateChunkTemplate = require("./HotUpdateChunkTemplate");
const ModuleTemplate = require("./ModuleTemplate");
const Dependency = require("./Dependency");
const ChunkRenderError = require("./ChunkRenderError");
const AsyncDependencyToInitialChunkWarning = require("./AsyncDependencyToInitialChunkWarning");
const CachedSource = require("webpack-sources").CachedSource;
const Stats = require("./Stats");
const Semaphore = require("./util/Semaphore");
const Queue = require("./util/Queue");

function byId(a, b) {
	if(a.id < b.id) return -1;
	if(a.id > b.id) return 1;
	return 0;
}

function iterationBlockVariable(variables, fn) {
	for(let indexVariable = 0; indexVariable < variables.length; indexVariable++) {
		const varDep = variables[indexVariable].dependencies;
		for(let indexVDep = 0; indexVDep < varDep.length; indexVDep++) {
			fn(varDep[indexVDep]);
		}
	}
}

function iterationOfArrayCallback(arr, fn) {
	for(let index = 0; index < arr.length; index++) {
		fn(arr[index]);
	}
}

class Compilation extends Tapable {
	constructor(compiler) {
		super();
		this.compiler = compiler;
		this.resolvers = compiler.resolvers;
		this.inputFileSystem = compiler.inputFileSystem;

		const options = this.options = compiler.options;
		this.outputOptions = options && options.output;
		this.bail = options && options.bail;
		this.profile = options && options.profile;
		this.performance = options && options.performance;

		// 最终 chunk 输出时候 使用的模板 【比如最开始写的那个 require 】

		this.mainTemplate = new MainTemplate(this.outputOptions);
		this.chunkTemplate = new ChunkTemplate(this.outputOptions);
		this.hotUpdateChunkTemplate = new HotUpdateChunkTemplate(this.outputOptions);
		this.moduleTemplate = new ModuleTemplate(this.outputOptions);

		this.semaphore = new Semaphore(options.parallelism || 100);

		//  入口  chunks  modules 等等

		this.entries = [];
		this.preparedChunks = [];
		this.entrypoints = {};
		this.chunks = [];
		this.namedChunks = {};
		this.modules = [];
		this._modules = {};
		this.cache = null;
		this.records = null;
		this.nextFreeModuleIndex = undefined;
		this.nextFreeModuleIndex2 = undefined;
		this.additionalChunkAssets = [];
		this.assets = {};
		this.errors = [];
		this.warnings = [];
		this.children = [];
		this.dependencyFactories = new Map();
		this.dependencyTemplates = new Map();
		this.dependencyTemplates.set("hash", "");
		this.childrenCounters = {};
	}

	getStats() {
		return new Stats(this);
	}

	templatesPlugin(name, fn) {
		this.mainTemplate.plugin(name, fn);
		this.chunkTemplate.plugin(name, fn);
	}

	addModule(module, cacheGroup) {
		const identifier = module.identifier();
		if(this._modules[identifier]) {
			return false;
		}
		const cacheName = (cacheGroup || "m") + identifier;
		if(this.cache && this.cache[cacheName]) {
			const cacheModule = this.cache[cacheName];

			let rebuild = true;
			if(!cacheModule.error && cacheModule.cacheable && this.fileTimestamps && this.contextTimestamps) {
				rebuild = cacheModule.needRebuild(this.fileTimestamps, this.contextTimestamps);
			}

			if(!rebuild) {
				cacheModule.disconnect();
				this._modules[identifier] = cacheModule;
				this.modules.push(cacheModule);
				cacheModule.errors.forEach(err => this.errors.push(err));
				cacheModule.warnings.forEach(err => this.warnings.push(err));
				return cacheModule;
			}
		}
		module.unbuild();
		this._modules[identifier] = module;
		if(this.cache) {
			this.cache[cacheName] = module;
		}
		this.modules.push(module);
		return true;
	}

	getModule(module) {
		const identifier = module.identifier();
		return this._modules[identifier];
	}

	findModule(identifier) {
		return this._modules[identifier];
	}

	//  模块构建 --
	buildModule(module, optional, origin, dependencies, thisCallback) {
		this.applyPlugins1("build-module", module);
		if(module.building) return module.building.push(thisCallback);
		const building = module.building = [thisCallback];

		function callback(err) {
			module.building = undefined;
			building.forEach(cb => cb(err));
		}
		module.build(this.options, this, this.resolvers.normal, this.inputFileSystem, (error) => {
			const errors = module.errors;
			for(let indexError = 0; indexError < errors.length; indexError++) {
				const err = errors[indexError];
				err.origin = origin;
				err.dependencies = dependencies;
				if(optional)
					this.warnings.push(err);
				else
					this.errors.push(err);
			}

			const warnings = module.warnings;
			for(let indexWarning = 0; indexWarning < warnings.length; indexWarning++) {
				const war = warnings[indexWarning];
				war.origin = origin;
				war.dependencies = dependencies;
				this.warnings.push(war);
			}
			module.dependencies.sort(Dependency.compare);
			if(error) {
				this.applyPlugins2("failed-module", module, error);
				return callback(error);
			}
			this.applyPlugins1("succeed-module", module);
			return callback();
		});
	}

	processModuleDependencies(module, callback) {
		const dependencies = [];

		function addDependency(dep) {
			for(let i = 0; i < dependencies.length; i++) {
				if(dep.isEqualResource(dependencies[i][0])) {
					return dependencies[i].push(dep);
				}
			}
			dependencies.push([dep]);
		}

		function addDependenciesBlock(block) {
			if(block.dependencies) {
				iterationOfArrayCallback(block.dependencies, addDependency);
			}
			if(block.blocks) {
				iterationOfArrayCallback(block.blocks, addDependenciesBlock);
			}
			if(block.variables) {
				iterationBlockVariable(block.variables, addDependency);
			}
		}
		addDependenciesBlock(module);
		this.addModuleDependencies(module, dependencies, this.bail, null, true, callback);
	}

	addModuleDependencies(module, dependencies, bail, cacheGroup, recursive, callback) {
		let _this = this;
		const start = _this.profile && Date.now();

		const factories = [];
		for(let i = 0; i < dependencies.length; i++) {
			const factory = _this.dependencyFactories.get(dependencies[i][0].constructor);
			if(!factory) {
				return callback(new Error(`No module factory available for dependency type: ${dependencies[i][0].constructor.name}`));
			}
			factories[i] = [factory, dependencies[i]];
		}
		asyncLib.forEach(factories, function iteratorFactory(item, callback) {
			const dependencies = item[1];

			const errorAndCallback = function errorAndCallback(err) {
				err.origin = module;
				_this.errors.push(err);
				if(bail) {
					callback(err);
				} else {
					callback();
				}
			};
			const warningAndCallback = function warningAndCallback(err) {
				err.origin = module;
				_this.warnings.push(err);
				callback();
			};

			const semaphore = _this.semaphore;
			semaphore.acquire(() => {
				if(_this === null) return semaphore.release();

				const factory = item[0];
				factory.create({
					contextInfo: {
						issuer: module.nameForCondition && module.nameForCondition(),
						compiler: _this.compiler.name
					},
					context: module.context,
					dependencies: dependencies
				}, function factoryCallback(err, dependentModule) {
					if(_this === null) return semaphore.release();

					let afterFactory;

					function isOptional() {
						return dependencies.filter(d => !d.optional).length === 0;
					}

					function errorOrWarningAndCallback(err) {
						if(isOptional()) {
							return warningAndCallback(err);
						} else {
							return errorAndCallback(err);
						}
					}

					function iterationDependencies(depend) {
						for(let index = 0; index < depend.length; index++) {
							const dep = depend[index];
							dep.module = dependentModule;
							dependentModule.addReason(module, dep);
						}
					}

					if(err) {
						semaphore.release();
						return errorOrWarningAndCallback(new ModuleNotFoundError(module, err, dependencies));
					}
					if(!dependentModule) {
						semaphore.release();
						return process.nextTick(callback);
					}
					if(_this.profile) {
						if(!dependentModule.profile) {
							dependentModule.profile = {};
						}
						afterFactory = Date.now();
						dependentModule.profile.factory = afterFactory - start;
					}

					dependentModule.issuer = module;
					const newModule = _this.addModule(dependentModule, cacheGroup);

					if(!newModule) { // from cache
						dependentModule = _this.getModule(dependentModule);

						if(dependentModule.optional) {
							dependentModule.optional = isOptional();
						}

						iterationDependencies(dependencies);

						if(_this.profile) {
							module.profile = module.profile || {};
							const time = Date.now() - start;
							if(!module.profile.dependencies || time > module.profile.dependencies) {
								module.profile.dependencies = time;
							}
						}

						semaphore.release();
						return process.nextTick(callback);
					}

					if(newModule instanceof Module) {
						if(_this.profile) {
							newModule.profile = dependentModule.profile;
						}

						newModule.optional = isOptional();
						newModule.issuer = dependentModule.issuer;
						dependentModule = newModule;

						iterationDependencies(dependencies);

						if(_this.profile) {
							const afterBuilding = Date.now();
							module.profile.building = afterBuilding - afterFactory;
						}

						semaphore.release();
						if(recursive) {
							return process.nextTick(_this.processModuleDependencies.bind(_this, dependentModule, callback));
						} else {
							return process.nextTick(callback);
						}
					}

					dependentModule.optional = isOptional();

					iterationDependencies(dependencies);

					_this.buildModule(dependentModule, isOptional(), module, dependencies, err => {
						if(_this === null) return semaphore.release();

						if(err) {
							semaphore.release();
							return errorOrWarningAndCallback(err);
						}

						if(_this.profile) {
							const afterBuilding = Date.now();
							dependentModule.profile.building = afterBuilding - afterFactory;
						}

						semaphore.release();
						if(recursive) {
							_this.processModuleDependencies(dependentModule, callback);
						} else {
							return callback();
						}
					});

				});
			});
		}, function finalCallbackAddModuleDependencies(err) {
			// In V8, the Error objects keep a reference to the functions on the stack. These warnings &
			// errors are created inside closures that keep a reference to the Compilation, so errors are
			// leaking the Compilation object. Setting _this to null workarounds the following issue in V8.
			// https://bugs.chromium.org/p/chromium/issues/detail?id=612191
			_this = null;

			if(err) {
				return callback(err);
			}

			return process.nextTick(callback);
		});
	}


	// _addModuleChain 用于寻找模块依赖关系 ---------

	_addModuleChain(context, dependency, onModule, callback) {
		const start = this.profile && Date.now();

		const errorAndCallback = this.bail ? (err) => {
			callback(err);
		} : (err) => {
			err.dependencies = [dependency];
			this.errors.push(err);
			callback();
		};

		if(typeof dependency !== "object" || dependency === null || !dependency.constructor) {
			throw new Error("Parameter 'dependency' must be a Dependency");
		}

		const moduleFactory = this.dependencyFactories.get(dependency.constructor);
		if(!moduleFactory) {
			throw new Error(`No dependency factory available for this dependency type: ${dependency.constructor.name}`);
		}

		this.semaphore.acquire(() => {
			moduleFactory.create({
				contextInfo: {
					issuer: "",
					compiler: this.compiler.name
				},
				context: context,
				dependencies: [dependency]
			}, (err, module) => {
				if(err) {
					this.semaphore.release();
					return errorAndCallback(new EntryModuleNotFoundError(err));
				}

				let afterFactory;

				if(this.profile) {
					if(!module.profile) {
						module.profile = {};
					}
					afterFactory = Date.now();
					module.profile.factory = afterFactory - start;
				}

				const result = this.addModule(module);
				if(!result) {
					module = this.getModule(module);

					onModule(module);

					if(this.profile) {
						const afterBuilding = Date.now();
						module.profile.building = afterBuilding - afterFactory;
					}

					this.semaphore.release();
					return callback(null, module);
				}

				if(result instanceof Module) {
					if(this.profile) {
						result.profile = module.profile;
					}

					module = result;

					onModule(module);

					moduleReady.call(this);
					return;
				}

				onModule(module);

				// buildModule -- 模块编译 ---------------

				this.buildModule(module, false, null, null, (err) => {
					if(err) {
						this.semaphore.release();
						return errorAndCallback(err);
					}

					if(this.profile) {
						const afterBuilding = Date.now();
						module.profile.building = afterBuilding - afterFactory;
					}

					moduleReady.call(this);
				});

				function moduleReady() {
					this.semaphore.release();
					this.processModuleDependencies(module, err => {
						if(err) {
							return callback(err);
						}

						return callback(null, module);
					});
				}
			});
		});
	}

	// step N -- make 事件中会使用 -> addEntry  ------------------------------------------------------------------------------------------------------
	// 查找入口文件 进行下一步模块绑定
	addEntry(context, entry, name, callback) {
		const slot = {
			name: name,
			module: null
		};
		this.preparedChunks.push(slot);

		// 处理模块依赖  ------

		this._addModuleChain(context, entry, (module) => {

			entry.module = module;
			this.entries.push(module);
			module.issuer = null;

		}, (err, module) => {
			if(err) {
				return callback(err);
			}

			if(module) {
				slot.module = module;
			} else {
				const idx = this.preparedChunks.indexOf(slot);
				this.preparedChunks.splice(idx, 1);
			}
			return callback(null, module);
		});
	}

	prefetch(context, dependency, callback) {
		this._addModuleChain(context, dependency, module => {

			module.prefetched = true;
			module.issuer = null;

		}, callback);
	}

	rebuildModule(module, thisCallback) {
		if(module.variables.length || module.blocks.length)
			throw new Error("Cannot rebuild a complex module with variables or blocks");
		if(module.rebuilding) {
			return module.rebuilding.push(thisCallback);
		}
		const rebuilding = module.rebuilding = [thisCallback];

		function callback(err) {
			module.rebuilding = undefined;
			rebuilding.forEach(cb => cb(err));
		}
		const deps = module.dependencies.slice();
		this.buildModule(module, false, module, null, (err) => {
			if(err) return callback(err);

			this.processModuleDependencies(module, (err) => {
				if(err) return callback(err);
				deps.forEach(d => {
					if(d.module && d.module.removeReason(module, d)) {
						module.forEachChunk(chunk => {
							if(!d.module.hasReasonForChunk(chunk)) {
								if(d.module.removeChunk(chunk)) {
									this.removeChunkFromDependencies(d.module, chunk);
								}
							}
						});
					}
				});
				callback();
			});

		});
	}

	finish() {
		const modules = this.modules;
		this.applyPlugins1("finish-modules", modules);

		for(let index = 0; index < modules.length; index++) {
			const module = modules[index];
			this.reportDependencyErrorsAndWarnings(module, [module]);
		}
	}

	unseal() {
		this.applyPlugins0("unseal");
		this.chunks.length = 0;
		this.namedChunks = {};
		this.additionalChunkAssets.length = 0;
		this.assets = {};
		this.modules.forEach(module => module.unseal());
	}

  // seal 方法 -- 用于整理Module和chunk 进行编译之后的 源码合并拆分等
	seal(callback) {
		this.applyPlugins0("seal");
		this.nextFreeModuleIndex = 0;
		this.nextFreeModuleIndex2 = 0;
		this.preparedChunks.forEach(preparedChunk => {
			const module = preparedChunk.module;
			const chunk = this.addChunk(preparedChunk.name, module);
			const entrypoint = this.entrypoints[chunk.name] = new Entrypoint(chunk.name);
			entrypoint.unshiftChunk(chunk);

			chunk.addModule(module);
			module.addChunk(chunk);
			chunk.entryModule = module;
			this.assignIndex(module);
			this.assignDepth(module);
		});
		this.processDependenciesBlocksForChunks(this.chunks.slice());
		this.sortModules(this.modules);
		this.applyPlugins0("optimize");

		while(this.applyPluginsBailResult1("optimize-modules-basic", this.modules) ||
			this.applyPluginsBailResult1("optimize-modules", this.modules) ||
			this.applyPluginsBailResult1("optimize-modules-advanced", this.modules)) { /* empty */ }
		this.applyPlugins1("after-optimize-modules", this.modules);

		while(this.applyPluginsBailResult1("optimize-chunks-basic", this.chunks) ||
			this.applyPluginsBailResult1("optimize-chunks", this.chunks) ||
			this.applyPluginsBailResult1("optimize-chunks-advanced", this.chunks)) { /* empty */ }
		this.applyPlugins1("after-optimize-chunks", this.chunks);

		this.applyPluginsAsyncSeries("optimize-tree", this.chunks, this.modules, (err) => {
			if(err) {
				return callback(err);
			}

			this.applyPlugins2("after-optimize-tree", this.chunks, this.modules);

			while(this.applyPluginsBailResult("optimize-chunk-modules-basic", this.chunks, this.modules) ||
				this.applyPluginsBailResult("optimize-chunk-modules", this.chunks, this.modules) ||
				this.applyPluginsBailResult("optimize-chunk-modules-advanced", this.chunks, this.modules)) { /* empty */ }
			this.applyPlugins2("after-optimize-chunk-modules", this.chunks, this.modules);

			const shouldRecord = this.applyPluginsBailResult("should-record") !== false;

			this.applyPlugins2("revive-modules", this.modules, this.records);
			this.applyPlugins1("optimize-module-order", this.modules);
			this.applyPlugins1("advanced-optimize-module-order", this.modules);
			this.applyPlugins1("before-module-ids", this.modules);
			this.applyPlugins1("module-ids", this.modules);
			this.applyModuleIds();
			this.applyPlugins1("optimize-module-ids", this.modules);
			this.applyPlugins1("after-optimize-module-ids", this.modules);

			this.sortItemsWithModuleIds();

			this.applyPlugins2("revive-chunks", this.chunks, this.records);
			this.applyPlugins1("optimize-chunk-order", this.chunks);
			this.applyPlugins1("before-chunk-ids", this.chunks);
			this.applyChunkIds();
			this.applyPlugins1("optimize-chunk-ids", this.chunks);
			this.applyPlugins1("after-optimize-chunk-ids", this.chunks);

			this.sortItemsWithChunkIds();

			if(shouldRecord)
				this.applyPlugins2("record-modules", this.modules, this.records);
			if(shouldRecord)
				this.applyPlugins2("record-chunks", this.chunks, this.records);

			this.applyPlugins0("before-hash");
			this.createHash();
			this.applyPlugins0("after-hash");

			if(shouldRecord)
				this.applyPlugins1("record-hash", this.records);

			this.applyPlugins0("before-module-assets");

			this.createModuleAssets();

			if(this.applyPluginsBailResult("should-generate-chunk-assets") !== false) {
				this.applyPlugins0("before-chunk-assets");

				// seal 中比较中要的点 --  createChunkAssets 准备进行 chunk 输出到文件系统 -----------
				this.createChunkAssets();

			}
			this.applyPlugins1("additional-chunk-assets", this.chunks);
			this.summarizeDependencies();
			if(shouldRecord)
				this.applyPlugins2("record", this, this.records);

			this.applyPluginsAsync("additional-assets", err => {
				if(err) {
					return callback(err);
				}
				this.applyPluginsAsync("optimize-chunk-assets", this.chunks, err => {
					if(err) {
						return callback(err);
					}
					this.applyPlugins1("after-optimize-chunk-assets", this.chunks);
					this.applyPluginsAsync("optimize-assets", this.assets, err => {
						if(err) {
							return callback(err);
						}
						this.applyPlugins1("after-optimize-assets", this.assets);
						if(this.applyPluginsBailResult("need-additional-seal")) {
							this.unseal();
							return this.seal(callback);
						}
						return this.applyPluginsAsync("after-seal", callback);
					});
				});
			});
		});
	}

	sortModules(modules) {
		modules.sort(byId);
	}

	reportDependencyErrorsAndWarnings(module, blocks) {
		for(let indexBlock = 0; indexBlock < blocks.length; indexBlock++) {
			const block = blocks[indexBlock];
			const dependencies = block.dependencies;

			for(let indexDep = 0; indexDep < dependencies.length; indexDep++) {
				const d = dependencies[indexDep];

				const warnings = d.getWarnings();
				if(warnings) {
					for(let indexWar = 0; indexWar < warnings.length; indexWar++) {
						const w = warnings[indexWar];

						const warning = new ModuleDependencyWarning(module, w, d.loc);
						this.warnings.push(warning);
					}
				}
				const errors = d.getErrors();
				if(errors) {
					for(let indexErr = 0; indexErr < errors.length; indexErr++) {
						const e = errors[indexErr];

						const error = new ModuleDependencyError(module, e, d.loc);
						this.errors.push(error);
					}
				}
			}

			this.reportDependencyErrorsAndWarnings(module, block.blocks);
		}
	}

	addChunk(name, module, loc) {
		if(name) {
			if(Object.prototype.hasOwnProperty.call(this.namedChunks, name)) {
				const chunk = this.namedChunks[name];
				if(module) {
					chunk.addOrigin(module, loc);
				}
				return chunk;
			}
		}
		const chunk = new Chunk(name, module, loc);
		this.chunks.push(chunk);
		if(name) {
			this.namedChunks[name] = chunk;
		}
		return chunk;
	}

	assignIndex(module) {
		const _this = this;

		const queue = [() => {
			assignIndexToModule(module);
		}];

		const iteratorAllDependencies = d => {
			queue.push(() => assignIndexToDependency(d));
		};

		function assignIndexToModule(module) {
			// enter module
			if(typeof module.index !== "number") {
				module.index = _this.nextFreeModuleIndex++;

				// leave module
				queue.push(() => module.index2 = _this.nextFreeModuleIndex2++);

				// enter it as block
				assignIndexToDependencyBlock(module);
			}
		}

		function assignIndexToDependency(dependency) {
			if(dependency.module) {
				queue.push(() => assignIndexToModule(dependency.module));
			}
		}

		function assignIndexToDependencyBlock(block) {
			let allDependencies = [];

			function iteratorDependency(d) {
				allDependencies.push(d);
			}

			function iteratorBlock(b) {
				queue.push(() => assignIndexToDependencyBlock(b));
			}

			if(block.variables) {
				iterationBlockVariable(block.variables, iteratorDependency);
			}

			if(block.dependencies) {
				iterationOfArrayCallback(block.dependencies, iteratorDependency);
			}
			if(block.blocks) {
				const blocks = block.blocks;
				let indexBlock = blocks.length;
				while(indexBlock--) {
					iteratorBlock(blocks[indexBlock]);
				}
			}

			let indexAll = allDependencies.length;
			while(indexAll--) {
				iteratorAllDependencies(allDependencies[indexAll]);
			}
		}

		while(queue.length) {
			queue.pop()();
		}
	}

	assignDepth(module) {
		function assignDepthToModule(module, depth) {
			// enter module
			if(typeof module.depth === "number" && module.depth <= depth) return;
			module.depth = depth;

			// enter it as block
			assignDepthToDependencyBlock(module, depth + 1);
		}

		function assignDepthToDependency(dependency, depth) {
			if(dependency.module) {
				queue.push(() => assignDepthToModule(dependency.module, depth));
			}
		}

		function assignDepthToDependencyBlock(block, depth) {
			function iteratorDependency(d) {
				assignDepthToDependency(d, depth);
			}

			function iteratorBlock(b) {
				assignDepthToDependencyBlock(b, depth);
			}

			if(block.variables) {
				iterationBlockVariable(block.variables, iteratorDependency);
			}

			if(block.dependencies) {
				iterationOfArrayCallback(block.dependencies, iteratorDependency);
			}

			if(block.blocks) {
				iterationOfArrayCallback(block.blocks, iteratorBlock);
			}
		}

		const queue = [() => {
			assignDepthToModule(module, 0);
		}];
		while(queue.length) {
			queue.pop()();
		}
	}

	// This method creates the Chunk graph from the Module graph
	processDependenciesBlocksForChunks(inputChunks) {
		// Process is splitting into two parts:
		// Part one traverse the module graph and builds a very basic chunks graph
		//   in chunkDependencies.
		// Part two traverse every possible way through the basic chunk graph and
		//   tracks the available modules. While traversing it connects chunks with
		//   eachother and Blocks with Chunks. It stops traversing when all modules
		//   for a chunk are already available. So it doesn't connect unneeded chunks.

		const chunkDependencies = new Map(); // Map<Chunk, Array<{Module, Chunk}>>
		const allCreatedChunks = new Set();

		// PART ONE

		const blockChunks = new Map();

		// Start with the provided modules/chunks
		const queue = inputChunks.map(chunk => ({
			block: chunk.entryModule,
			chunk: chunk
		}));

		let block, chunk;

		// For each async Block in graph
		const iteratorBlock = b => {
			// 1. We create a chunk for this Block
			// but only once (blockChunks map)
			let c = blockChunks.get(b);
			if(c === undefined) {
				c = this.namedChunks[b.chunkName];
				if(c && c.isInitial()) {
					// TODO webpack 4: convert this to an error
					this.warnings.push(new AsyncDependencyToInitialChunkWarning(b.chunkName, b.module, b.loc));
					c = chunk;
				} else {
					c = this.addChunk(b.chunkName, b.module, b.loc);
					blockChunks.set(b, c);
					allCreatedChunks.add(c);
					// We initialize the chunks property
					// this is later filled with the chunk when needed
					b.chunks = [];
				}
			}

			// 2. We store the Block+Chunk mapping as dependency for the chunk
			let deps = chunkDependencies.get(chunk);
			if(!deps) chunkDependencies.set(chunk, deps = []);
			deps.push({
				block: b,
				chunk: c
			});

			// 3. We enqueue the DependenciesBlock for traversal
			queue.push({
				block: b,
				chunk: c
			});
		};

		// For each Dependency in the graph
		const iteratorDependency = d => {
			// We skip Dependencies without Module pointer
			if(!d.module) {
				return;
			}
			// We skip weak Dependencies
			if(d.weak) {
				return;
			}
			// We connect Module and Chunk when not already done
			if(chunk.addModule(d.module)) {
				d.module.addChunk(chunk);

				// And enqueue the Module for traversal
				queue.push({
					block: d.module,
					chunk
				});
			}
		};

		// Iterative traversal of the Module graph
		// Recursive would be simpler to write but could result in Stack Overflows
		while(queue.length) {
			const queueItem = queue.pop();
			block = queueItem.block;
			chunk = queueItem.chunk;

			// Traverse all variables, Dependencies and Blocks
			if(block.variables) {
				iterationBlockVariable(block.variables, iteratorDependency);
			}

			if(block.dependencies) {
				iterationOfArrayCallback(block.dependencies, iteratorDependency);
			}

			if(block.blocks) {
				iterationOfArrayCallback(block.blocks, iteratorBlock);
			}
		}

		// PART TWO

		let availableModules;
		let newAvailableModules;
		const queue2 = new Queue(inputChunks.map(chunk => ({
			chunk,
			availableModules: new Set()
		})));

		// Helper function to check if all modules of a chunk are available
		const areModulesAvailable = (chunk, availableModules) => {
			for(const module of chunk.modulesIterable) {
				if(!availableModules.has(module))
					return false;
			}
			return true;
		};

		// For each edge in the basic chunk graph
		const filterFn = dep => {
			// Filter egdes that are not needed because all modules are already available
			// This also filters circular dependencies in the chunks graph
			const depChunk = dep.chunk;
			if(areModulesAvailable(depChunk, newAvailableModules))
				return false; // break all modules are already available
			return true;
		};

		const minAvailableModulesMap = new Map();

		// Iterative traversing of the basic chunk graph
		while(queue2.length) {
			const queueItem = queue2.dequeue();
			chunk = queueItem.chunk;
			availableModules = queueItem.availableModules;

			// 1. Get minimal available modules
			// It doesn't make sense to traverse a chunk again with more available modules.
			// This step calculates the minimal available modules and skips traversal when
			// the list didn't shrink.
			let minAvailableModules = minAvailableModulesMap.get(chunk);
			if(minAvailableModules === undefined) {
				minAvailableModulesMap.set(chunk, new Set(availableModules));
			} else {
				let deletedModules = false;
				for(const m of minAvailableModules) {
					if(!availableModules.has(m)) {
						minAvailableModules.delete(m);
						deletedModules = true;
					}
				}
				if(!deletedModules)
					continue;
				availableModules = minAvailableModules;
			}

			// 2. Get the edges at this point of the graph
			const deps = chunkDependencies.get(chunk);
			if(!deps) continue;
			if(deps.length === 0) continue;

			// 3. Create a new Set of available modules at this points
			newAvailableModules = new Set(availableModules);
			for(const m of chunk.modulesIterable)
				newAvailableModules.add(m);

			// 4. Filter edges with available modules
			const filteredDeps = deps.filter(filterFn);

			// 5. Foreach remaining edge
			const nextChunks = new Set();
			for(let i = 0; i < filteredDeps.length; i++) {
				const dep = filteredDeps[i];
				const depChunk = dep.chunk;
				const depBlock = dep.block;

				// 6. Connnect block with chunk
				if(depChunk.addBlock(depBlock)) {
					depBlock.chunks.push(depChunk);
				}

				// 7. Connect chunk with parent
				if(chunk.addChunk(depChunk)) {
					depChunk.addParent(chunk);
				}

				nextChunks.add(depChunk);
			}

			// 8. Enqueue further traversal
			for(const nextChunk of nextChunks) {
				queue2.enqueue({
					chunk: nextChunk,
					availableModules: newAvailableModules
				});
			}
		}

		// Remove all unconnected chunks
		for(const chunk of allCreatedChunks) {
			if(chunk.parents.length === 0)
				chunk.remove("unconnected");
		}
	}

	removeChunkFromDependencies(block, chunk) {
		const iteratorDependency = d => {
			if(!d.module) {
				return;
			}
			if(!d.module.hasReasonForChunk(chunk)) {
				if(d.module.removeChunk(chunk)) {
					this.removeChunkFromDependencies(d.module, chunk);
				}
			}
		};

		const blocks = block.blocks;
		for(let indexBlock = 0; indexBlock < blocks.length; indexBlock++) {
			const chunks = blocks[indexBlock].chunks;
			for(let indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
				const blockChunk = chunks[indexChunk];
				chunk.removeChunk(blockChunk);
				blockChunk.removeParent(chunk);
				this.removeChunkFromDependencies(chunks, blockChunk);
			}
		}

		if(block.dependencies) {
			iterationOfArrayCallback(block.dependencies, iteratorDependency);
		}

		if(block.variables) {
			iterationBlockVariable(block.variables, iteratorDependency);
		}
	}

	applyModuleIds() {
		const unusedIds = [];
		let nextFreeModuleId = 0;
		const usedIds = [];
		// TODO consider Map when performance has improved https://gist.github.com/sokra/234c077e1299b7369461f1708519c392
		const usedIdMap = Object.create(null);
		if(this.usedModuleIds) {
			Object.keys(this.usedModuleIds).forEach(key => {
				const id = this.usedModuleIds[key];
				if(!usedIdMap[id]) {
					usedIds.push(id);
					usedIdMap[id] = true;
				}
			});
		}

		const modules1 = this.modules;
		for(let indexModule1 = 0; indexModule1 < modules1.length; indexModule1++) {
			const module1 = modules1[indexModule1];
			if(module1.id && !usedIdMap[module1.id]) {
				usedIds.push(module1.id);
				usedIdMap[module1.id] = true;
			}
		}

		if(usedIds.length > 0) {
			let usedIdMax = -1;
			for(let index = 0; index < usedIds.length; index++) {
				const usedIdKey = usedIds[index];

				if(typeof usedIdKey !== "number") {
					continue;
				}

				usedIdMax = Math.max(usedIdMax, usedIdKey);
			}

			let lengthFreeModules = nextFreeModuleId = usedIdMax + 1;

			while(lengthFreeModules--) {
				if(!usedIdMap[lengthFreeModules]) {
					unusedIds.push(lengthFreeModules);
				}
			}
		}

		const modules2 = this.modules;
		for(let indexModule2 = 0; indexModule2 < modules2.length; indexModule2++) {
			const module2 = modules2[indexModule2];
			if(module2.id === null) {
				if(unusedIds.length > 0)
					module2.id = unusedIds.pop();
				else
					module2.id = nextFreeModuleId++;
			}
		}
	}

	applyChunkIds() {
		const unusedIds = [];
		let nextFreeChunkId = 0;

		function getNextFreeChunkId(usedChunkIds) {
			const keyChunks = Object.keys(usedChunkIds);
			let result = -1;

			for(let index = 0; index < keyChunks.length; index++) {
				const usedIdKey = keyChunks[index];
				const usedIdValue = usedChunkIds[usedIdKey];

				if(typeof usedIdValue !== "number") {
					continue;
				}

				result = Math.max(result, usedIdValue);
			}

			return result;
		}

		if(this.usedChunkIds) {
			nextFreeChunkId = getNextFreeChunkId(this.usedChunkIds) + 1;
			let index = nextFreeChunkId;
			while(index--) {
				if(this.usedChunkIds[index] !== index) {
					unusedIds.push(index);
				}
			}
		}

		const chunks = this.chunks;
		for(let indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
			const chunk = chunks[indexChunk];
			if(chunk.id === null) {
				if(unusedIds.length > 0)
					chunk.id = unusedIds.pop();
				else
					chunk.id = nextFreeChunkId++;
			}
			if(!chunk.ids) {
				chunk.ids = [chunk.id];
			}
		}
	}

	sortItemsWithModuleIds() {
		this.modules.sort(byId);

		const modules = this.modules;
		for(let indexModule = 0; indexModule < modules.length; indexModule++) {
			modules[indexModule].sortItems(false);
		}

		const chunks = this.chunks;
		for(let indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
			chunks[indexChunk].sortItems();
		}
	}

	sortItemsWithChunkIds() {
		this.chunks.sort(byId);

		for(let indexModule = 0; indexModule < this.modules.length; indexModule++) {
			this.modules[indexModule].sortItems(true);
		}

		for(let indexChunk = 0; indexChunk < this.chunks.length; indexChunk++) {
			this.chunks[indexChunk].sortItems();
		}

		const byMessage = (a, b) => {
			const ma = `${a.message}`;
			const mb = `${b.message}`;
			if(ma < mb) return -1;
			if(mb < ma) return 1;
			return 0;
		};

		this.errors.sort(byMessage);
		this.warnings.sort(byMessage);
	}

	summarizeDependencies() {
		function filterDups(array) {
			const newArray = [];
			for(let i = 0; i < array.length; i++) {
				if(i === 0 || array[i - 1] !== array[i])
					newArray.push(array[i]);
			}
			return newArray;
		}
		this.fileDependencies = (this.compilationDependencies || []).slice();
		this.contextDependencies = [];
		this.missingDependencies = [];

		for(let indexChildren = 0; indexChildren < this.children.length; indexChildren++) {
			const child = this.children[indexChildren];

			this.fileDependencies = this.fileDependencies.concat(child.fileDependencies);
			this.contextDependencies = this.contextDependencies.concat(child.contextDependencies);
			this.missingDependencies = this.missingDependencies.concat(child.missingDependencies);
		}

		for(let indexModule = 0; indexModule < this.modules.length; indexModule++) {
			const module = this.modules[indexModule];

			if(module.fileDependencies) {
				const fileDependencies = module.fileDependencies;
				for(let indexFileDep = 0; indexFileDep < fileDependencies.length; indexFileDep++) {
					this.fileDependencies.push(fileDependencies[indexFileDep]);
				}
			}
			if(module.contextDependencies) {
				const contextDependencies = module.contextDependencies;
				for(let indexContextDep = 0; indexContextDep < contextDependencies.length; indexContextDep++) {
					this.contextDependencies.push(contextDependencies[indexContextDep]);
				}
			}
		}
		this.errors.forEach(error => {
			if(Array.isArray(error.missing)) {
				error.missing.forEach(item => this.missingDependencies.push(item));
			}
		});
		this.fileDependencies.sort();
		this.fileDependencies = filterDups(this.fileDependencies);
		this.contextDependencies.sort();
		this.contextDependencies = filterDups(this.contextDependencies);
		this.missingDependencies.sort();
		this.missingDependencies = filterDups(this.missingDependencies);
	}

	createHash() {
		const outputOptions = this.outputOptions;
		const hashFunction = outputOptions.hashFunction;
		const hashDigest = outputOptions.hashDigest;
		const hashDigestLength = outputOptions.hashDigestLength;
		const hash = crypto.createHash(hashFunction);
		if(outputOptions.hashSalt)
			hash.update(outputOptions.hashSalt);
		this.mainTemplate.updateHash(hash);
		this.chunkTemplate.updateHash(hash);
		this.moduleTemplate.updateHash(hash);
		this.children.forEach(function(child) {
			hash.update(child.hash);
		});
		this.warnings.forEach(function(warning) {
			hash.update(`${warning.message}`);
		});
		this.errors.forEach(function(error) {
			hash.update(`${error.message}`);
		});
		// clone needed as sort below is inplace mutation
		const chunks = this.chunks.slice();
		/**
		 * sort here will bring all "falsy" values to the beginning
		 * this is needed as the "hasRuntime()" chunks are dependent on the
		 * hashes of the non-runtime chunks.
		 */
		chunks.sort((a, b) => {
			const aEntry = a.hasRuntime();
			const bEntry = b.hasRuntime();
			if(aEntry && !bEntry) return 1;
			if(!aEntry && bEntry) return -1;
			return 0;
		});
		for(let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const chunkHash = crypto.createHash(hashFunction);
			if(outputOptions.hashSalt)
				chunkHash.update(outputOptions.hashSalt);
			chunk.updateHash(chunkHash);
			if(chunk.hasRuntime()) {
				this.mainTemplate.updateHashForChunk(chunkHash, chunk);
			} else {
				this.chunkTemplate.updateHashForChunk(chunkHash, chunk);
			}
			this.applyPlugins2("chunk-hash", chunk, chunkHash);
			chunk.hash = chunkHash.digest(hashDigest);
			hash.update(chunk.hash);
			chunk.renderedHash = chunk.hash.substr(0, hashDigestLength);
		}
		this.fullHash = hash.digest(hashDigest);
		this.hash = this.fullHash.substr(0, hashDigestLength);
	}

	modifyHash(update) {
		const outputOptions = this.outputOptions;
		const hashFunction = outputOptions.hashFunction;
		const hashDigest = outputOptions.hashDigest;
		const hashDigestLength = outputOptions.hashDigestLength;
		const hash = crypto.createHash(hashFunction);
		hash.update(this.fullHash);
		hash.update(update);
		this.fullHash = hash.digest(hashDigest);
		this.hash = this.fullHash.substr(0, hashDigestLength);
	}

	createModuleAssets() {
		for(let i = 0; i < this.modules.length; i++) {
			const module = this.modules[i];
			if(module.assets) {
				Object.keys(module.assets).forEach((assetName) => {
					const fileName = this.getPath(assetName);
					this.assets[fileName] = module.assets[assetName];
					this.applyPlugins2("module-asset", module, fileName);
				});
			}
		}
	}

	// createChunkAssets --------------------
	// 目前为止 所有的 chunk 都是 通过require的方法 引入的代码  需要根据 template 生成 _webpack_require() 的格式
	// 使用 template 模板文件 生成的chunk
	createChunkAssets() {
		const outputOptions = this.outputOptions;
		const filename = outputOptions.filename;
		const chunkFilename = outputOptions.chunkFilename;
		for(let i = 0; i < this.chunks.length; i++) {
			const chunk = this.chunks[i];
			chunk.files = [];
			const chunkHash = chunk.hash;
			let source;
			let file;
			const filenameTemplate = chunk.filenameTemplate ? chunk.filenameTemplate :
				chunk.isInitial() ? filename :
				chunkFilename;
			try {
				const useChunkHash = !chunk.hasRuntime() || (this.mainTemplate.useChunkHash && this.mainTemplate.useChunkHash(chunk));
				const usedHash = useChunkHash ? chunkHash : this.fullHash;
				const cacheName = "c" + chunk.id;
				if(this.cache && this.cache[cacheName] && this.cache[cacheName].hash === usedHash) {
					source = this.cache[cacheName].source;
				} else {
					if(chunk.hasRuntime()) {

						// mainTemplate --  处理入口文件的 Module  --- 可以去看一下  mainTemplate 中的render方法
						source = this.mainTemplate.render(this.hash, chunk, this.moduleTemplate, this.dependencyTemplates);
					} else {

						// chunkTemplate -- 处理异步加载的Module
						source = this.chunkTemplate.render(chunk, this.moduleTemplate, this.dependencyTemplates);
					}
					if(this.cache) {
						this.cache[cacheName] = {
							hash: usedHash,
							source: source = (source instanceof CachedSource ? source : new CachedSource(source))
						};
					}
				}
				file = this.getPath(filenameTemplate, {
					noChunkHash: !useChunkHash,
					chunk
				});
				if(this.assets[file])
					throw new Error(`Conflict: Multiple assets emit to the same filename ${file}`);


				// 拿到 经过template 处理的chunk内容 保存到 compilation.assets 中 -----------------------

				this.assets[file] = source;
				chunk.files.push(file);
				this.applyPlugins2("chunk-asset", chunk, file);
			} catch(err) {
				this.errors.push(new ChunkRenderError(chunk, file || filenameTemplate, err));
			}
		}
	}

	getPath(filename, data) {
		data = data || {};
		data.hash = data.hash || this.hash;
		return this.mainTemplate.applyPluginsWaterfall("asset-path", filename, data);
	}

	createChildCompiler(name, outputOptions, plugins) {
		const idx = (this.childrenCounters[name] || 0);
		this.childrenCounters[name] = idx + 1;
		return this.compiler.createChildCompiler(this, name, idx, outputOptions, plugins);
	}

	checkConstraints() {
		const usedIds = {};

		const modules = this.modules;
		for(let indexModule = 0; indexModule < modules.length; indexModule++) {
			const moduleId = modules[indexModule].id;

			if(usedIds[moduleId])
				throw new Error(`checkConstraints: duplicate module id ${moduleId}`);
		}

		const chunks = this.chunks;
		for(let indexChunk = 0; indexChunk < chunks.length; indexChunk++) {
			const chunk = chunks[indexChunk];

			if(chunks.indexOf(chunk) !== indexChunk)
				throw new Error(`checkConstraints: duplicate chunk in compilation ${chunk.debugId}`);
			chunk.checkConstraints();
		}
	}
}

module.exports = Compilation;