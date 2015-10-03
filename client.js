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

        this.replicants = {};

        let self = this;
        this._io.on('replicantSet', function() {
            self.onServerSet.apply(self, arguments);
        });
        this._io.on('replicantChanged', function() {
            self.onServerChange.apply(self, arguments);
        });
    }

    getReplicant(name) {
        if (!this.replicants[name]) {
            this.replicants[name] = new Replicant(this, name);
        }

        return this.replicants[name];
    }

    onServerSet(name, revisionHistory, newValue) {
        let replicant = this.getReplicant(name);

        replicant.onServerSet(revisionHistory, newValue);
    }

    onServerChange(name, revisionHistory, changes) {
        let replicant = this.getReplicant(name);

        replicant.onServerChange(revisionHistory, changes);
    }
}

class Replicant extends EventEmitter {
    constructor(replicator, name) {
        super();

        this._replicator = replicator;
        this.name = name;
        this.ready = false;
        this._updating = false;
        this._revisionNum = 0;
        this.revisionHistory = [];

        this._replicator._io.emit('replicantRegister', this.name, function() {
            this.synchronize();
            this.ready = true;
            this.emit('ready');
        }.bind(this));
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

    onServerSet(revisionHistory, newValue) {
        this._updating = true;
        this.value = newValue;
        this.revisionHistory = revisionHistory;
        this._revisionNum = revisionHistory.length;
        this._updating = false;
    }

    onServerChange(revisionHistory, changes) {
        if (this.revision === revisionHistory[1]) {
            let newValue = applyChanges(this.value, changes);

            this._updating = true;
            this.value = newValue;
            this.revisionHistory = revisionHistory;
            this._revisionNum = revisionHistory.length;
            this._updating = false;
        }
        else {
            this.synchronize();
        }
    }

    pushChanges(oldValue, newValue, changes) {
        this._revisionNum++;
        this.revisionHistory.unshift(this.revision);

        let self = this;
        if (changes) {
            this._replicator._io.emit('replicantChanged', this.name, this.revisionHistory, changes, function(success) {
                if (!success) {
                    self._replicator._io.emit('replicantSet', self.name, self.revisionHistory, newValue);
                }
            });
        }
        else {
            this._replicator._io.emit('replicantSet', this.name, this.revisionHistory, newValue, function(success) {
                if (!success) {
                    self.synchronize();
                }
            });
        }
    }

    synchronize() {
        let self = this;
        this._replicator._io.emit('replicantGet', this.name, function(revisionHistory, value) {
            self._updating = true;
            self.value = value;
            self.revisionHistory = revisionHistory;
            self._revisionNum = revisionHistory.length;
            self._updating = false;
        });
    }
}

module.exports = Replicator;
