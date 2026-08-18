const mongoose = require("mongoose");

const printSettongSchema = new mongoose.Schema(
  {
    title: {
      type: String,
    },
    description: {
      type: String,
    },
    headerData: {
      name: {
        type: String,
      },
      address: {
        type: String,
      },
    },
    pageSettings: {
      pageSize: {
        type: String,
        enum: ["A4", "A3", "Letter"],
        default: "A4",
      },
      orientation: {
        type: String,
        enum: ["portrait", "landscape"],
        default: "portrait",
      },
      showHeader: {
        type: Boolean,
        default: true,
      },
      showFooter: {
        type: Boolean,
        default: true,
      },
    },
    typography: {
      headerData: {
        family: {
          type: String,
          default: "Arial, sans-serif",
        },
        size: {
          type: String,
          default: "16px",
        },
        color: {
          type: String,
          default: "#000000",
        },
      },

      footerData: {
        family: {
          type: String,
          default: "Arial, sans-serif",
        },
        size: {
          type: String,
          default: "14px",
        },
        weight: {
          type: String,
          default: "normal",
        },
        color: {
          type: String,
          default: "#000000",
        },
      },
    },

    signature: {
      signatureUrl: {
        type: String,
      },
      sealUrl: {
        type: String,
      },
    },
    logoSettings: {
      showLeftLogo: {
        type: Boolean,
      },
      showRightLogo: {
        type: Boolean,
      },
      leftLogoSize: {
        type: String,
        enum: ["small", "medium", "large"],
        default: "medium",
      },
      rightLogoSize: {
        type: String,
        enum: ["small", "medium", "large"],
        default: "medium",
      },
      leftLogoUrl: {
        type: String,
      },
      rightLogoUrl: {
        type: String,
      },
    },
    watermarkSettings: {
      showWatermark: {
        type: Boolean,
        default: true,
      },
      opacity: {
        type: Number,
        default: 10,
        min: 0,
        max: 100,
      },
      size: {
        type: String,
        enum: ["small", "medium", "large"],
        default: "medium",
      },

      watermarkUrl: String,
    },
    footerSetting: {
      showSignatory: {
        type: Boolean,
        default: true,
      },
      showDate: {
        type: Boolean,
        default: true,
      },
      showSeal: {
        type: Boolean,
        default: true,
      },
      signatoryPosition: {
        type: Number,
        enum: [1, 2, 3],
        default: 1,
      },
      datePosition: {
        type: Number,
        enum: [1, 2, 3],
        default: 2,
      },
      sealPosition: {
        type: Number,
        enum: [1, 2, 3],
        default: 3,
      },
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

printSettongSchema.pre("save", function (next) {
  this.updatedAt = Date.now();
  next();
});

module.exports = mongoose.model("print-Setting", printSettongSchema);
