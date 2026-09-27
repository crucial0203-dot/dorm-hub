/**
 * webfs-adapter.js —— 无名杀纯静态托管的浏览器文件系统适配层
 *
 * 原理：官方 noname 提供 window.initReadWriteFunction 钩子（见 noname/init/index.js），
 * 供自定义平台注入 game.checkFile/readFile/writeFile 等文件读写函数。
 * 本适配器用 OPFS（Origin Private File System）实现这些函数，使游戏可部署在
 * 纯静态托管（无 node 服务器）上：存档/设置/扩展写入 OPFS，游戏本体文件读取
 * 在 OPFS 未命中时回落到 HTTP 同路径。
 *
 * 必须在 index.html 官方内联脚本之前加载（官方逻辑见已有的 initReadWriteFunction 则跳过）。
 */
(function () {
	'use strict';
	if (typeof window.initReadWriteFunction === 'function') return;
	if (!window.navigator || !navigator.storage || typeof navigator.storage.getDirectory !== 'function') return;

	var _enc = new TextEncoder();

	function norm(p) {
		return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
	}

	function splitPath(p) {
		p = norm(p);
		var i = p.lastIndexOf('/');
		return { dir: i === -1 ? '' : p.slice(0, i), name: i === -1 ? p : p.slice(i + 1) };
	}

	function getDirHandle(path, create) {
		path = norm(path);
		var h = navigator.storage.getDirectory();
		if (!path) return h;
		var segs = path.split('/').filter(function (s) { return s && s !== '.'; });
		return h.then(function (root) {
			var cur = Promise.resolve(root);
			segs.forEach(function (seg) {
				cur = cur.then(function (d) { return d.getDirectoryHandle(seg, { create: !!create }); });
			});
			return cur;
		});
	}

	function classify(path) {
		var sp = splitPath(path);
		if (!sp.name) return Promise.resolve('dir');
		return getDirHandle(sp.dir, false).then(function (d) {
			return d.getFileHandle(sp.name).then(function (fh) {
				return fh.getFile().then(function () { return 'file'; });
			}).catch(function () {
				return d.getDirectoryHandle(sp.name).then(function () { return 'dir'; });
			});
		}).catch(function () { return 'missing'; });
	}

	function opfsRead(path, asText) {
		var sp = splitPath(path);
		return getDirHandle(sp.dir, false).then(function (d) {
			return d.getFileHandle(sp.name);
		}).then(function (fh) {
			return fh.getFile();
		}).then(function (f) {
			return asText ? f.text() : f.arrayBuffer();
		});
	}

	function httpRead(path, asText) {
		var url = './' + norm(path);
		return fetch(url).then(function (res) {
			if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
			return asText ? res.text() : res.arrayBuffer();
		});
	}

	function toBytes(data) {
		if (typeof data === 'string') return Promise.resolve(_enc.encode(data));
		if (typeof Blob !== 'undefined' && data instanceof Blob) return data.arrayBuffer().then(function (b) { return new Uint8Array(b); });
		if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
		if (ArrayBuffer.isView(data)) return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
		return Promise.resolve(_enc.encode(String(data)));
	}

	window.initReadWriteFunction = async function (game) {
		game.checkFile = function (fileName, callback, onerror) {
			classify(fileName).then(function (k) {
				callback(k === 'file' ? 1 : k === 'dir' ? 0 : -1);
			}).catch(function (e) { if (onerror) onerror(String(e)); });
		};

		game.checkDir = function (dir, callback, onerror) {
			classify(dir).then(function (k) {
				callback(k === 'dir' ? 1 : k === 'file' ? 0 : -1);
			}).catch(function (e) { if (onerror) onerror(String(e)); });
		};

		game.readFile = function (fileName, callback, error) {
			opfsRead(fileName, false).then(callback, function () {
				httpRead(fileName, false).then(callback, error || function () {});
			});
		};

		game.readFileAsText = function (fileName, callback, error) {
			opfsRead(fileName, true).then(callback, function () {
				httpRead(fileName, true).then(callback, error || function () {});
			});
		};

		game.writeFile = function (data, path, name, callback) {
			var filePath;
			if (typeof path === 'string' && path.endsWith('/')) filePath = norm(path + name);
			else if (path === '' || path == null) filePath = norm(name);
			else filePath = norm(path + '/' + name);
			var sp = splitPath(filePath);
			toBytes(data).then(function (bytes) {
				return getDirHandle(sp.dir, true).then(function (d) {
					return d.getFileHandle(sp.name, { create: true });
				}).then(function (fh) {
					return fh.createWritable();
				}).then(function (w) {
					return w.write(bytes).then(function () { return w.close(); });
				});
			}).then(function () {
				if (callback) callback();
			}).catch(function (e) {
				if (callback) callback(String(e));
			});
		};

		game.removeFile = function (fileName, callback) {
			var sp = splitPath(fileName);
			getDirHandle(sp.dir, false).then(function (d) {
				return d.removeEntry(sp.name);
			}).then(function () {
				if (callback) callback();
			}).catch(function () {
				if (callback) callback(); // 目标不存在视为已删除
			});
		};

		game.getFileList = function (dir, callback, onerror) {
			getDirHandle(dir, false).then(function (d) {
				var folders = [], files = [];
				var it = d.entries();
				function step() {
					return it.next().then(function (r) {
						if (r.done) { callback(folders, files); return; }
						(r.value[1].kind === 'directory' ? folders : files).push(r.value[0]);
						return step();
					});
				}
				return step();
			}).catch(function (e) { if (onerror) onerror(e); });
		};

		game.ensureDirectory = function (list, callback, file) {
			var pathArray = typeof list === 'string' ? list.split('/') : list;
			if (file) pathArray = pathArray.slice(0, -1);
			game.createDir(pathArray.join('/'), callback, console.error);
		};

		game.createDir = function (directory, successCallback, errorCallback) {
			getDirHandle(directory, true).then(function () {
				if (successCallback) successCallback();
			}).catch(function (e) {
				if (errorCallback) errorCallback(e);
			});
		};

		game.removeDir = function (directory, successCallback, errorCallback) {
			var sp = splitPath(directory);
			if (!sp.name) { if (errorCallback) errorCallback(new Error('cannot remove root')); return; }
			getDirHandle(sp.dir, false).then(function (d) {
				return d.removeEntry(sp.name, { recursive: true });
			}).then(function () {
				if (successCallback) successCallback();
			}).catch(function (e) {
				if (errorCallback) errorCallback(e);
			});
		};
	};
})();
