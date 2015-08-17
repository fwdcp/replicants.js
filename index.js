"use strict";

class Replicants {
    constructor(io, options) {
        if (!io) {
            throw new Error('Socket.IO instance is null');
        }

        this.io = io;

        if (!options) {
            options = {};
        }

        options.namespace = options.hasOwnProperty('namespace') ? options.namespace || '/';
        options.roomPrefix = options.hasOwnProperty('roomPrefix') ? options.roomPrefix || 'replicant-';
    }
};

module.exports = Replicants;
