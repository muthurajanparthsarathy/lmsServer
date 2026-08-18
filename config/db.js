const mongoose = require("mongoose");
require("dotenv").config();

const connectDB = async () => {
  try {
    // Measured against this Atlas cluster, the SRV lookup plus handshake takes
    // ~10.3s from here. Mongoose's DEFAULT bufferTimeoutMS is 10s, so the first
    // query fired by an incoming request was being rejected roughly 300ms before
    // the connection finished — surfacing as:
    //     MongooseError: Operation `lms-users.findOne()` buffering timed out
    //                    after 10000ms
    // The connection itself was never broken, which is why it looked
    // intermittent: it depended on whether a request arrived inside that window.
    //
    // Both numbers are raised well clear of the measured time rather than just
    // past it, so ordinary network variance cannot put it back over the line.
    // bufferTimeoutMS is a MONGOOSE-level setting, not a driver connect option —
    // passing it to connect() throws "option buffertimeoutms is not supported".
    // It governs how long a query may sit queued waiting for the connection,
    // which is precisely the timeout that was firing.
    mongoose.set("bufferTimeoutMS", 45000);

    await mongoose.connect(process.env.MONGOURI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
      // Driver option: how long to hunt for a reachable server before failing.
      serverSelectionTimeoutMS: 30000,
      // Keeps a warm pool so later requests don't pay the handshake again.
      minPoolSize: 2,
    });

    console.log("MongoDB Connected...");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
};

module.exports = connectDB;