var http = require('http');
var ServerReplicator = require('..');
var ClientReplicator = require('../client');

var env = {};

describe('replicants', function() {
    before(function() {
        env._httpServer = http.createServer();
        env._httpServer.listen(0, function() {
            env._socketServer = require('socket.io')(env._httpServer);
            env.serverReplicator = new ServerReplicator(env._socketServer);

            env._socketClient = require('socket.io-client')('http://localhost:' + env._httpServer.address().port);
            env.clientReplicator = new ClientReplicator(env._socketClient);
        });
    });

    describe('server-side', function() {
        it('can be initialized', function() {
            var repServer = env.serverReplicator.getReplicant('serverInitializationTest');
        });
    });

    describe('client-side', function() {
        it('can be initialized', function(done) {
            var repClient = env.clientReplicator.getReplicant('clientInitializationTest');

            repClient.once('ready', done);
        });
    });
});
