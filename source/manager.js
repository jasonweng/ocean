// Module manager.
var manager = (function () {
	var PATTERN_EXTNAME = /\.\w+$/,

		PATTERN_FILENAME = /[^\/]+$/,

		PATTERN_PARAMS = /^(.*?)(\?.*)?$/,

		PATTERN_PROTOCOL = /\w+?:/,

		STATUS = {
			DEFINED: 1,
			COMPILED: 2,
			INITIALIZED: 3,
			BROKEN: 4
		},

		// id -> module map.
		cache = {},

		// id -> parameter map.
		params = {},

		// id -> reversing-dependencies map.
		hanging = {},

		exports = {
			/**
			 * Compile a module.
			 * @param module {Object}
			 */
			compile: function (module) {
					// Not initialized dependencies.
				var waiting = [],

					// Not loaded dependencies.
					missing = [],

					deps, i, len, id, meta;

				if (module.status >= STATUS.COMPILED) { // Avoid duplicated compiling.
					return;
				}

				module.status = STATUS.COMPILED;
				deps = this.require(module.dependencies);

				for (i = 0, len = deps.length; i < len; ++i) {
					if (!deps[i]) { // Found not initialized dependency.
						id = module.dependencies[i];
						waiting.push(id);
						if (deps[i] === UNDEFINED) { // Found not loaded dependency.
							// undefined means new face, null means loading.
							cache[id] = null;
							missing.push(id);
						}
					}
				}

				if (waiting.length > 0) { // Hang some-dependencies-unready module.
					meta = {
						module: module,
						count: waiting.length
					};

					for (i = 0, len = waiting.length; i < len; ++i) {
						id = waiting[i];
						if (hanging[id]) {
							hanging[id].push(meta);
						} else {
							hanging[id] = [ meta ];
						}
					}

					if (missing.length > 0) { // Load new faces.
						this.load(missing);
					}
				} else {
					// Initialize all-dependencies-ready module.
					this.initialize(module);
				}
			},

			/**
			 * Define a module.
			 * @param id {string}
			 * @param dependencies {Array}
			 * @param factory {Function}
			 * @return {Object}
			 */
			define: function (id, dependencies, factory) {
				var module = cache[id];

				if (!module) { // Avoid duplicated defining.
					module = {
						exports: null,
						factory: factory,
						id: id,
						status: STATUS.DEFINED
					};

					// Id is resolved base on current module.
					module.dependencies = this.resolve(module, dependencies);

					if (id) { // Save named module.
						cache[id] = module;
						if (hanging[id]) { // Compile reversing-depended module immediately.
							this.compile(module);
						}
					}
				}

				return module;
			},

			/**
			 * Initialize a module.
			 * @param module {Object}
			 */
			initialize: function (module) {
				var exports = module.exports = {},
					self = this,
					require;

				// Id is resolved base on current module.
				require = function (id) {
					id = self.resolve(module, id);
					return self.require([ id ])[0];
				};

				// Id is resolved base on current module.
				require.async = function (ids, callback) {
					ids = self.resolve(module, ids);
					return self.use(ids, callback);
				};

				try {
					exports = module.factory.call(null, require, exports, module);
					if (exports) {
						module.exports = exports;
					}
					module.status = STATUS.INITIALIZED;
					// Try to initialize hanging modules
					// which are depended on current module.
					this.trigger(module.id);
				} catch (err) {
					// Rollback exports object when error occurred.
					module.exports = null;
					module.status = STATUS.BROKEN;
					throw err;
				}
			},

			/**
			 * Load new-face modules.
			 * @param ids {Array}
			 */
			load: function (ids) {
				var len = ids.length,
					i = 0,
					id;

				for (; i < len; ++i) {
					id = ids[i];
					// Load JS file with its own parameter.
					loader.load(id + (params[id] || ''));
				}
			},

			/**
			 * Get required modules.
			 * @param ids {Array}
			 * @return {Array}
			 */
			require: function (ids) {
				var result = [],
					i, len, id, module;

				for (i = 0, len = ids.length; i < len; ++i) {
					id = ids[i];
					module = cache[id];

					if (module) {
						if (!module.exports) { // Try to compile unready module.
							this.compile(module);
						}
						result[i] = module.exports;
					} else { // Id in cache means the module is loading.
						result[i] = (id in cache) ? null : UNDEFINED;
					}
				}

				return result;
			},

			/**
			 * Resolve id based on current module.
			 * @param currentModule {Object}
			 * @param ids {Array|string}
			 * @return {Array|string}
			 */
			resolve: function (currentModule, ids) {
				var i, len, id, re, search,
					single = false;

				if (typeof ids === 'string') {
					single = true;
					ids = [ ids ];
				}

				for (i = 0, len = ids.length; i < len; ++i) {
					id = ids[i];

					// Resolve alias.
					if (id.charAt(0) === '#') {
						id = id.substring(1);
					} else {
						id = ids[i].split('/');
						id[0] = config.alias[id[0]] || id[0];
						id = id.join('/');
					}

					// Generate URI.
					if (id.charAt(0) === '.') { // Related to current module.
						id = currentModule.id.replace(PATTERN_FILENAME, id);
					} else if (!PATTERN_PROTOCOL.test(id)) { // Related to base.
						id = config.base + id;
					}

					// Append default extname.
					if (id.charAt(id.length - 1) === '#') {
						id = id.substring(0, id.length - 1);
					} else if (id.indexOf('?') === -1 && !PATTERN_EXTNAME.test(id)) {
						id += '.js';
					}

					// Trim parameters.
					re = id.match(PATTERN_PARAMS);
					id = re[1];
					search = re[2];

					// Normalize uri.
					id = util.normalize(id);

					// Save parameter.
					if (search) {
						params[id] = search;
					}

					ids[i] = id;
				}

				return single ? ids[0] : ids;
			},

			/**
			 * Try to initialize hanging modules.
			 * @param id {string}
			 */
			trigger: function (id) {
				var self = this,
					next;

				if (typeof hanging[id] === 'object') { // Has hanging modules of current id.
					next = function () {
						var meta;

						if (hanging[id].length > 0) {
							meta = hanging[id].shift();

							// Trigger next step before possible runtime error occurs.
							setTimeout(next, 0);

							if (--meta.count === 0) { // All depenencies ready.
								self.initialize(meta.module);
							}
						} else {
							delete hanging[id];
						}
					};
					// Execute asynchronously to isolate possible runtime error
					// in module factory.
					setTimeout(next, 0);
				}
			},

			/**
			 * Use modules.
			 * @param ids {Array|string}
			 * @param callback {Function}
			 */
			use: function (ids, callback) {
				var self = this;

				if (typeof ids === 'string') {
					ids = [ ids ];
				}

				// Using modules equals initializing an anonymous module
				// which depended on used modules.
				this.compile(this.define(null, ids, function () {
					if (callback) {
						callback.apply(null, self.require(ids));
					}
				}));
			}
		};

	return exports;
}());
