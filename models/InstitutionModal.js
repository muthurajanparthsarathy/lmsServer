const mongoose = require("mongoose");


const institutionSchema = new mongoose.Schema({
    inst_id: {
        type: String,
        required: [true, "inst_id is required"] 
    },
    inst_name: {
        type: String,
        required: [true, "inst_name is required"] 
    },

    inst_owner: {
        type: String,
        required: [true, "owner name is required"] 

    },
    
    phone: {
        type: String,
        required: [true, "phone is required"] 

    },
    address: {
        type: String,
        required: [true, "address is required"] 
    },
   basedOn: {
        type: String,
        required: [true, "basedOn is required"]
    },
    userIdCounter: {
        type: Number,
        default: 0,
    },
    createdAt: {
        type: Date,
        default: new Date(),
    },
    createdBy: { 
        type: String, 
        default: 'self', 
        required: [true, "createdBy is required"] 
    },
});


module.exports = mongoose.model("LMS-Institution", institutionSchema);
