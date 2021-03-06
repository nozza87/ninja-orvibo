var util = require("util"); // For inheriting the EventEmitter stuff so we can use it via this.emit();
var EventEmitter = require("events").EventEmitter; // For emitting events so other node.js libraries and code can react to what we're doing here
var os = require("os"); // Used to check if we're running Windows, Linux or Mac (needed so we don't crash our app while binding our socket. Stupid bugs!

var sDgram = require('dgram'); // this library gives us UDP support
var scktClient = sDgram.createSocket('udp4'); // For sending data
var scktServer = sDgram.createSocket('udp4'); // For receiving data

var localIP = getBroadcastAddress(); // Get our local IP address
var broadcastip = "255.255.255.255"; // Where we'll send our "discovery" packet

var hosts = []; // The array that will hold all of our disocvered sockets
var port = 10000 // The port we'll connect on
var payload = []; // The data we'll be sending
var twenties = ['0x20', '0x20', '0x20', '0x20', '0x20', '0x20']; // this appears at the end of a few packets we send, so put it here for shortness of code

var e = new EventEmitter(); // For emitting events such as "power changed" etc.

util.inherits(OrviboSocket, EventEmitter); // We want to get all the benefits of EventEmitter, but in our own class. this means we can use this.emit("Derp");

function OrviboSocket() { // The main function in our module. AFAIK, this is akin to a class myClass { } thing in PHP
	EventEmitter.call(this); // Needed so we can emit() from this module

	scktServer.on('message', function (message, remote) { // We've got a message back from the network
	    if (remote.address != localIP) { //Check message isn't from us
			this.emit("messagereceived", message, remote.address, remote.port); // It's not from us, so let everyone know we've got data
	        var MessageHex = new Buffer(message).toString('hex'); // Convert our message into a string of hex
			var macAddress = MessageHex.substr(MessageHex.indexOf('accf'), 12); // Look for the first occurance of ACCF (the start of our MAC address) and grab it, plus the next 12 bytes

			index = hosts.map(function(e) { return e.macaddress; }).indexOf(macAddress); // Use the arr.map() and indexOf functions to find out where in our array, our socket is

			switch(MessageHex.substr(0,12)) { // Look for the first twelve bytes
				case "6864002a7161": // We've asked for all sockets on the network, and smoeone has replied!
					if(index == -1) { // If we haven't got this IP address in our host array yet..
						hosts.push({ // Add it to our array
							"name": "", // The name of our socket. We don't know it yet!
							"ipaddress": remote.address, // The IP address of our socket
							"macaddress": macAddress, // And the MAC address
							"subscribed": false, // We haven't subscribed to this socket yet
							"state": false // And because we don't know the state, assume it's off. Our subscription packet will change that.\
						});

						this.emit("socketfound", hosts.length - 1, remote.address, macAddress); // Tell the world we've found a socket!
					}
					break;
					
				case "686400a87274": // We've queried the socket for the name, and we've got data coming back
					if(hosts[index].name === "") { // If we haven't added the name of our socket to our array yet

						var strName = MessageHex.split("202020202020")[4]; // We want everything after the fourth 202020202020 which is where our name starts
						strName = strName.split("2020202020")[0]; // And we want everything between our name and the next 202020202020 (our name is bookended between twenties!)
						if(strName.toString('hex').substr(0,6) == "ffffff") {
							strName = "Orvibo Socket " + macAddress;
						} else {
							strName = hex2a(strName.toString('hex')); // Turn our buffer into a hex string and then turn that into a string
						}
						
						this.emit('namechanged', hosts[index].name, strName) // Let everyone know the name of the socket has changed
						hosts[index].name = strName; // Add our name to the array.
						this.emit("queried", index, strName); // We're done querying, so tell everyone. Include the name and index for record keeping
					}
					break;
				
				case "68640018636c": // We've asked to subscribe to a socket, and this is confirmation. It also includes the state of our socket (00 = off, 01 = on)
					hosts[index].state = MessageHex.substr(MessageHex.length - 1,1) == 0 ? false : true; // Pull out the state from our socket and set it in our array
					hosts[index].subscribed = true; // We've now properly subscribed, so set our subscribed property to true
					this.emit("subscribed", index, hosts[index].state); // Emit that we've subscribed, plus the index (in the array) of our socket, plus the current state
					break;
				
				case '686400176463': // We've asked to turn the socket on or off, and this is the confirmation that it's been done
					hosts[index].state = MessageHex.substr(MessageHex.length - 1,1) == 0 ? false : true; // Fetch our state from the packet and set it
					if(hosts[index].state == true) { // If we're powering on
						this.emit("poweredon", index, true); // Tell everyone we're powered on
					} else if(hosts[index].state == false) { // Same, but reversed
						this.emit("poweredoff", index, false); // Tell everyone we're off.
					}
					break;
					
				case '686400177366': // Something has changed the state of our socket (e.g. pressing the button on the socket or the app)
					hosts[index].state = MessageHex.substr(MessageHex.length - 1,1) == 0 ? 0 : 1; // Extract the state, same as always
					this.emit("statechanged", index, hosts[index].state); // Tell the world we've changed. Include our index and state
					break;
					
				default: // For everything else
					break;
			}	
			
		}
	}.bind(this));
}

OrviboSocket.prototype.prepare = function() { // Begin listening on our ports
	// Due to some funkyness between operating systems or possibly node.js versions, we need to bind our client in two different ways.
	if(os.type() == "Windows_NT") { // Windows will only work if we setBroadcast(true) in a callback
		scktClient.bind(port, function() {
			scktClient.setBroadcast(true); // If we don't do this, we can't send broadcast packets to x.x.x.255, so we can never discover our sockets!		
		});
	} else { // While node.js on Linux (Raspbian, but possibly other distros) will chuck the sads if we have a callback, even if the callback does absolutely nothing (possibly a bug)
		scktClient.bind(port);
		scktClient.setBroadcast(true); // If we don't do this, we can't send broadcast packets to x.x.x.255, so we can never discover our sockets!
	}
	
	scktServer.bind(port, localIP); // Listen on port 10000
	this.emit("ready"); // TO-DO: Change this to something else, as it means we're bound, NOT that we're ready to turn the socket on and off. Potentially confusing!
}

OrviboSocket.prototype.discover = function() { // To discover sockets, we send out the payload below. Any socket that is configured should report back.
    payload = []; // Clear out the payload variable
    payload = payload.concat(['0x68', '0x64', '0x00', '0x06', '0x71', '0x61']); // Our broadcast packet. No MAC address required!
	this.sendMessage(payload, broadcastip, function(){
		this.emit("discovering"); // Tell everyone we're in the process of discovering
	}.bind(this)); 
}

OrviboSocket.prototype.subscribe = function() { // We've found a socket, now we just need to subscribe to it so we can control it.
	hosts.forEach(function(item) { // // Loop through each found socket
		if(item.subscribed == false) { // Only subscribe if we haven't done so already
			macReversed = hex2ba(item.macaddress); // Convert our MAC address into a byte array (e.g. [0x12, 0x23] etc.)
			macReversed = macReversed.slice().reverse(); // And reverse the individual sections (e.g. ACCF becomes CFAC etc.)
		    payload = []; // Clear out our payload
		    payload = payload.concat(['0x68', '0x64', '0x00', '0x1e', '0x63', '0x6c'], hex2ba(item.macaddress), twenties, macReversed, twenties); // The subscription packet
		    this.sendMessage(payload, item.ipaddress, function(){ // Send the message and when that's done..
				this.emit("subscribing"); // Let everyone know
			}.bind(this)); 
		}
	}.bind(this));
}

OrviboSocket.prototype.setState = function(index, state) { // Here's where the magic begins! this function takes a boolean (state) and turns our socket on or off depending
	payload = [];

	if(state == true) {
	    payload = payload.concat(['0x68', '0x64', '0x00', '0x17', '0x64', '0x63'], hex2ba(hosts[index].macaddress), twenties, ['0x00', '0x00', '0x00', '0x00', '0x01']); // ON
	} else {
	     payload = payload.concat(['0x68', '0x64', '0x00', '0x17', '0x64', '0x63'], hex2ba(hosts[index].macaddress), twenties, ['0x00', '0x00', '0x00', '0x00', '0x00']); // OFF
	}

    this.sendMessage(payload, hosts[index].ipaddress, function(){
		this.emit("statechanging", index, state); // Let everyone know we've asked for a state change
	}.bind(this)); 

}

OrviboSocket.prototype.query = function() { // Query all subscribed sockets for their name
	hosts.forEach(function(item, index) {

		if(item.subscribed == true) { // We can only query if we're subscribing
			payload = [];
			payload = payload.concat(['0x68', '0x64', '0x00', '0x1d', '0x72', '0x74'], hex2ba(item.macaddress), twenties, ['0x00', '0x00', '0x00', '0x00', '0x04', '0x00', '0x00', '0x00', '0x00', '0x00', '0x00']);
			this.sendMessage(payload, hosts[index].ipaddress, function() {
				this.emit('querying', index); // Tell the world we're querying the sockets for their name
				
			}.bind(this));
		}
	}.bind(this));
}
		

OrviboSocket.prototype.hosts = hosts; // Give the calling module access to the list of sockets we've found

OrviboSocket.prototype.getState = function(index) { // Get the state of any given socket
	return hosts[index].state;
}



OrviboSocket.prototype.sendMessage = function(message, sHost, callback) { // The fun (?) part of our module. Sending of the messages!

    message = new Buffer(message); // We need to send as a buffer. this line takes our message and makes it into one. 
    process.nextTick(function() { // Next time we're processing stuff. To keep our app from running away from us, I suppose
		scktClient.send(message, 0, message.length, port, sHost, function(err, bytes) { // Send the message. Parameter 2 is offset, so it's 0. 
	        if (err) throw err; // Error? CRASH AND BURN BB!
	        this.emit("messageSent", message, sHost, scktServer.address().address); // Tell the world we've sent a packet. Include message, who it's being sent to, plus the address it's being sent from
	    }.bind(this)); // Again, we do .bind(this) so calling this.emit(); comes from OrviboSocket, and not from scktClient
		callback(); // And if we've specified a callback function, go right ahead and do that, as we've sent the message
	}.bind(this));
}


function getBroadcastAddress() { // A bit of code that lets us get our network IP address
    var os = require('os')

	var interfaces = os.networkInterfaces(); // Get a list of interfaces
	var addresses = [];
	for (k in interfaces) { // Loop through our interfaces
	    for (k2 in interfaces[k]) { // And our sub-interfaces
	        var address = interfaces[k][k2]; // Get the address 
	        if (address.family == 'IPv4' && !address.internal) { // If we're IPv4 and it's not an internal address (like 127.0.0.1)
	            addresses.push(address.address) // Shove it onto our addresses array
	        }
	    }
	}

	return addresses;
}

function hex2ba(hex) { // Takes a string of hex and turns it into a byte array: ['0xAC', '0xCF] etc.
    arr = []; // New array
	for (var i = 0; i < hex.length; i += 2) { // Loop through our string, jumping by 2 each time
	    arr.push("0x" + hex.substr(i, 2)); // Push 0x and the next two bytes onto the array
	}
	return arr;
}

function c(msg) { // Shortcut for "console.log". Saves typing when debugging.
	console.log(msg);
}

function hex2a(hexx) { // Takes a hex string and turns it into an ASCII string
    var hex = hexx.toString();//force conversion
    var str = '';
    for (var i = 0; i < hex.length; i += 2)
        str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    return str;
}

module.exports = OrviboSocket; // And make every OrviboSocket function available to whatever file wishes to use it. 