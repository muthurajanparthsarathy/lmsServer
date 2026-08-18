const mongoose = require('mongoose');

const PedagogyStructureDynamicSchema = new mongoose.Schema({
  institution: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Institution',
    required: true,
    unique: true,
  },
  I_Do: {
    type: [String],
    default: [],
    validate: {
      validator: function(arr) {
        return arr.length <= 50;
      },
      message: 'I_Do cannot have more than 50 elements'
    }
  },
  We_Do: {
    type: [String],
    default: [],
    validate: {
      validator: function(arr) {
        return arr.length <= 50;
      },
      message: 'We_Do cannot have more than 50 elements'
    }
  },
  You_Do: {
    type: [String],
    default: [],
    validate: {
      validator: function(arr) {
        return arr.length <= 50;
      },
      message: 'You_Do cannot have more than 50 elements'
    }
  },
  createdBy: {
    type:String,
  },
  updatedBy: {
    type:String,
  }
}, {
  timestamps: true
});

// Indexes
PedagogyStructureDynamicSchema.index({ institution: 1 });
PedagogyStructureDynamicSchema.index({ createdAt: -1 });

// Instance methods
PedagogyStructureDynamicSchema.methods.addElement = function(section, element) {
  if (!['I_Do', 'We_Do', 'You_Do'].includes(section)) {
    throw new Error('Invalid section. Must be I_Do, We_Do, or You_Do');
  }
  
  if (this[section].length >= 50) {
    throw new Error(`${section} section is full. Maximum 50 elements allowed.`);
  }
  
  this[section].push(element);
  return this;
};

PedagogyStructureDynamicSchema.methods.removeElement = function(section, index) {
  if (!['I_Do', 'We_Do', 'You_Do'].includes(section)) {
    throw new Error('Invalid section. Must be I_Do, We_Do, or You_Do');
  }
  
  if (index < 0 || index >= this[section].length) {
    throw new Error('Invalid element index');
  }
  
  this[section].splice(index, 1);
  return this;
};

// Add this method to your schema
PedagogyStructureDynamicSchema.methods.updateArrayElement = function(section, elementId, newValue) {
  if (!['I_Do', 'We_Do', 'You_Do'].includes(section)) {
    throw new Error('Invalid section. Must be I_Do, We_Do, or You_Do');
  }

  const index = this[section].findIndex(item => item === elementId);
  if (index === -1) {
    throw new Error('Element not found in the specified section');
  }

  this[section][index] = newValue;
  this.updatedBy = this._context?.userId; // Set from controller
  return this.save();
};

// Add this method to your schema
PedagogyStructureDynamicSchema.methods.deleteArrayElement = function(section, elementId) {
  if (!['I_Do', 'We_Do', 'You_Do'].includes(section)) {
    throw new Error('Invalid section. Must be I_Do, We_Do, or You_Do');
  }

  const index = this[section].findIndex(item => item === elementId);
  if (index === -1) {
    throw new Error('Element not found in the specified section');
  }

  this[section].splice(index, 1);
  this.updatedBy = this._context?.userId; // Set from controller
  return this.save();
};

module.exports = mongoose.model('PedagogyStructureDynamic', PedagogyStructureDynamicSchema);