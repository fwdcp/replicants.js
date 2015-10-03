/* jshint node: true, esnext: true */

"use strict";

var clone = require('clone');
var EventEmitter = require('events');
var hash = require('object-hash');
var Nested = require('nested-observe');
var objectPath = require('object-path');

function applyChanges(startValue, changes) {
    let newValue = clone(startValue);
    let newChanges = clone(changes);

    newChanges.forEach(function(change) {
        if (change.type === 'add') {
            objectPath.set(newValue, change.path, change.newValue);
        }
        else if (change.type === 'update') {
            objectPath.set(newValue, change.path, change.newValue);
        }
        else if (change.type === 'splice') {
            let arr = objectPath.get(newValue, change.path);
            if (!arr) {
                arr = [];
            }

            let args = change.added;
            args.unshift(change.removedCount);
            args.unshift(change.index);
            Array.prototype.splice.apply(arr, args);
            objectPath.set(newValue, change.path, arr);
        }
        else if (change.type === 'delete') {
            objectPath.del(newValue, change.path);
        }
    });

    return newValue;
}

function reverseChanges(startValue, changes) {
    let oldValue = clone(startValue);
    let reversedChanges = clone(changes).reverse();

    reversedChanges.forEach(function(change) {
        if (change.type === 'add') {
            objectPath.del(oldValue, change.path);
        }
        else if (change.type === 'update') {
            objectPath.set(oldValue, change.path, change.oldValue);
        }
        else if (change.type === 'splice') {
            let arr = objectPath.get(oldValue, change.path);
            if (!arr) {
                arr = [];
            }

            let args = change.removed;
            args.unshift(change.addedCount);
            args.unshift(change.index);
            Array.prototype.splice.apply(arr, args);
            objectPath.set(oldValue, change.path, arr);
        }
        else if (change.type === 'delete') {
            objectPath.set(oldValue, change.path, change.oldValue);
        }
    });

    return oldValue;
}

class Replicator {
    constructor(io, options) {
        if (!io) {
            throw new Error('Socket.IO instance is null');
        }

        this._io = io;

        if (!options) {
            options = {};
        }

        options.namespace = options.hasOwnProperty('namespace') ? options.namespace : '/';
        options.roomPrefix = options.hasOwnProperty('roomPrefix') ? options.roomPrefix : 'replicants/';

        if (options.namespace !== '/') {
            this._io = this._io.namespace(options.namespace);
        }

        this.roomPrefix = options.roomPrefix;

        this.replicants = {};

        let self = this;
        this._io.on('connection', function(socket) {
            socket.on('replicantRegister', self.onClientRegister.bind(self, socket));
            socket.on('replicantGet', self.onClientGet.bind(self, socket));
            socket.on('replicantSet', self.onClientSet.bind(self, socket));
            socket.on('replicantChanged', self.onClientChange.bind(self, socket));
        });
    }

    getReplicant(name) {
        if (!this.replicants[name]) {
            this.replicants[name] = new Replicant(this, name);
        }

        return this.replicants[name];
    }

    onClientRegister(socket, name, callback) {
        let replicant = this.getReplicant(name);
        socket.join(this.roomPrefix + replicant.name);

        callback();
    }

    onClientGet(socket, name, callback) {
        let replicant = this.getReplicant(name);

        replicant.onClientGet(socket, callback);
    }

    onClientSet(socket, name, revisionHistory, newValue, acknowledge) {
        let replicant = this.getReplicant(name);

        replicant.onClientSet(socket, revisionHistory, newValue, acknowledge);
    }

    onClientChange(socket, name, revisionHistory, changes, acknowledge) {
        let replicant = this.getReplicant(name);

        replicant.onClientChange(socket, revisionHistory, changes, acknowledge);
    }
}

class Replicant {
    constructor(replicator, name) {
        this._replicator = replicator;
        this.name = name;
        this._updating = false;
        this._revisionNum = 0;
        this.revisionHistory = [];
    }

    get value() {
        return this._value;
    }

    set value(newValue) {
        if (!this._updating) {
            let oldValue = this._value;

            this.pushChanges(oldValue, newValue, null);
        }
        else {
            // NOTE: we may try to observe non-objects, so we throw away any errors if that fails

            try {
                Nested.unobserve(this._value, this.onChange.bind(this));
            }
            catch (e) {}

            this._value = newValue;

            try {
                Nested.observe(this._value, this.onChange.bind(this));
            }
            catch (e) {}
        }
    }

    get revision() {
        return hash.sha1({
            num: this._revisionNum,
            value: this.value
        });
    }

    set revision(newRev) {}

    onChange(rawChanges) {
        if (!this._updating) {
            let formattedChanges = [];

            rawChanges.forEach(function(change) {
                let path = change.path.substr(1).replace(/\//g,'.');
                let newVal = objectPath.get(change.root, path);

                if (change.type === 'add') {
                    formattedChanges.push({
                        type: 'add',
                        path: path,
                        newValue: newVal
                    });
                }
                else if (change.type === 'update') {
                    formattedChanges.push({
                        type: 'update',
                        path: path,
                        oldValue: change.oldValue,
                        newValue: newVal
                    });
                }
                else if (change.type === 'splice') {
                    formattedChanges.push({
                        type: 'splice',
                        path: path,
                        index: change.index,
                        removed: change.removed,
                        removedCount: change.removed.length,
                        added: change.object.slice(change.index, change.index + change.addedCount),
                        addedCount: change.addedCount
                    });
                }
                else if (change.type === 'delete') {
                    formattedChanges.push({
                        type: 'delete',
                        path: path,
                        oldValue: change.oldValue
                    });
                }
                else {
                    formattedChanges.push({
                        type: change.type,
                        path: path
                    });
                }
            });

            let oldValue = reverseChanges(this.value, formattedChanges);

            this.pushChanges(oldValue, this.value, formattedChanges);
        }
    }

    onClientGet(socket, callback) {
        callback(this.revisionHistory, this.value);
    }

    onClientSet(socket, revisionHistory, newValue, acknowledge) {
        if (revisionHistory.indexOf(this.revisionHistory[0]) !== -1) {
            acknowledge(true);
            this.revisionHistory = revisionHistory.slice(1);
            this._revisionNum = this.revisionHistory.length;
            this.pushChanges(this.value, newValue, null);
        }
        else {
            acknowledge(false);
        }
    }

    onClientChange(socket, revisionHistory, changes, acknowledge) {
        if (revisionHistory[1] === this.revisionHistory[0]) {
            acknowledge(true);
            let newValue = applyChanges(this.value, changes);
            this.pushChanges(this.value, newValue, changes);
        }
        else {
            acknowledge(false);
        }
    }

    pushChanges(oldValue, newValue, changes) {
        this._updating = true;
        this.value = newValue;
        this._revisionNum++;
        this.revisionHistory.unshift(this.revision);
        this._updating = false;

        if (changes) {
            this._replicator._io.to(this._replicator.roomPrefix + this.name).emit('replicantChanged', this.name, this.revisionHistory, changes);
        }
        else {
            this._replicator._io.to(this._replicator.roomPrefix + this.name).emit('replicantSet', this.name, this.revisionHistory, newValue);
        }
    }
}

module.exports = Replicator;
