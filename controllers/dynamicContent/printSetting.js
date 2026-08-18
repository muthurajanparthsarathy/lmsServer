const PrintSetting = require("../../models/dynamicContent/PrintSettingModels");
const mongoose = require("mongoose");
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

exports.createPrintSetting = async (req, res) => {
  try {
    const {
      title,
      description,
      headerData,
      pageSettings,
      typography,
      footerSetting,
      watermarkSettings,
    } = req.body;

    // Manually extract logoSettings properties
    const logoSettings = {
      showLeftLogo: req.body['logoSettings[showLeftLogo]'] === 'true' || req.body.logoSettings?.showLeftLogo === true,
      showRightLogo: req.body['logoSettings[showRightLogo]'] === 'true' || req.body.logoSettings?.showRightLogo === true,
      leftLogoSize: req.body['logoSettings[leftLogoSize]'] || req.body.logoSettings?.leftLogoSize || 'medium',
      rightLogoSize: req.body['logoSettings[rightLogoSize]'] || req.body.logoSettings?.rightLogoSize || 'medium'
    };

    // Similarly for other nested objects if needed
    const extractedFooterSetting = {
      showSignatory: req.body['footerSetting[showSignatory]'] === 'true' || req.body.footerSetting?.showSignatory === true,
      showDate: req.body['footerSetting[showDate]'] === 'true' || req.body.footerSetting?.showDate === true,
      showSeal: req.body['footerSetting[showSeal]'] === 'true' || req.body.footerSetting?.showSeal === true,
      signatoryPosition: parseInt(req.body['footerSetting[signatoryPosition]']) || req.body.footerSetting?.signatoryPosition || 1,
      datePosition: parseInt(req.body['footerSetting[datePosition]']) || req.body.footerSetting?.datePosition || 2,
      sealPosition: parseInt(req.body['footerSetting[sealPosition]']) || req.body.footerSetting?.sealPosition || 3
    };

    const extractedWatermarkSettings = {
      showWatermark: req.body['watermarkSettings[showWatermark]'] === 'true' || req.body.watermarkSettings?.showWatermark === true,
      opacity: parseInt(req.body['watermarkSettings[opacity]']) || req.body.watermarkSettings?.opacity || 10,
      size: req.body['watermarkSettings[size]'] || req.body.watermarkSettings?.size || 'medium'
    };

    if (!title || !description) {
      return res.status(400).json({
        message: [
          { key: "error", value: "Title and description are required" },
        ],
      });
    }

    let leftLogoUrl, rightLogoUrl, signatureUrl, sealUrl, watermarkUrl;

    const uploadImage = async (file, folder) => {
      const uniqueFileName = `${Date.now()}_${file.name}`;
      const { error } = await supabase.storage
        .from("smartlms")
        .upload(`print-settings/${folder}/${uniqueFileName}`, file.data);

      if (error) throw new Error(error.message);

      return `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/print-settings/${folder}/${uniqueFileName}`;
    };

    if (req.files?.leftLogo)
      leftLogoUrl = await uploadImage(req.files.leftLogo, "logos");
    if (req.files?.rightLogo)
      rightLogoUrl = await uploadImage(req.files.rightLogo, "logos");
    if (req.files?.signature)
      signatureUrl = await uploadImage(req.files.signature, "signatures");
    if (req.files?.seal) sealUrl = await uploadImage(req.files.seal, "seals");
    if (req.files?.watermark)
      watermarkUrl = await uploadImage(req.files.watermark, "watermarks");

    const newSetting = new PrintSetting({
      title,
      description,
      headerData,
      pageSettings,
      typography,
      footerSetting: extractedFooterSetting,
      watermarkSettings: {
        ...extractedWatermarkSettings,
        watermarkUrl,
      },
      signature: {
        signatureUrl,
        sealUrl,
      },
      logoSettings: {
        ...logoSettings,
        leftLogoUrl,
        rightLogoUrl,
      },
    });

    const saved = await newSetting.save();



    return res.status(201).json({
      message: [
        { key: "success", value: "Print setting created successfully" },
      ],
      data: saved,
    });
  } catch (error) {
    console.error("Error creating print setting:", error);
    return res.status(500).json({
      message: [
        { key: "error", value: "Server error while creating print setting" },
      ],
    });
  }
};

exports.getPrintSettings = async (req, res) => {
  try {
    const settings = await PrintSetting.find().sort({ createdAt: -1 });
    return res.status(200).json({
      message: [
        { key: "success", value: "Print settings retrieved successfully" },
      ],
      data: settings,
    });
  } catch (error) {
    console.error("Error fetching print settings:", error);
    return res.status(500).json({
      message: [
        { key: "error", value: "Server error while fetching print settings" },
      ],
    });
  }
};

exports.getPrintSettingById = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid print setting ID format" }],
      });
    }

    const setting = await PrintSetting.findById(id);

    if (!setting) {
      return res.status(404).json({
        message: [{ key: "error", value: "Print setting not found" }],
      });
    }

    return res.status(200).json({
      message: [
        { key: "success", value: "Print setting retrieved successfully" },
      ],
      data: setting,
    });
  } catch (error) {
    console.error("Error fetching print setting by ID:", error);
    return res.status(500).json({
      message: [
        { key: "error", value: "Server error while fetching print setting" },
      ],
    });
  }
};

const deleteFromSupabase = async (url, folder) => {
  if (!url) return;

  try {
    const fileName = url.split("/").pop();
    const { error } = await supabase.storage
      .from("smartlms")
      .remove([`print-settings/${folder}/${fileName}`]);

    if (error) console.error(`Error deleting ${folder} from Supabase:`, error);
  } catch (err) {
    console.error(`Error cleaning ${folder} path:`, err);
  }
};

const uploadToSupabase = async (file, folder) => {
  const uniqueFileName = `${Date.now()}_${file.name}`;
  const { error } = await supabase.storage
    .from("smartlms")
    .upload(`print-settings/${folder}/${uniqueFileName}`, file.data);

  if (error) throw new Error(error.message);

  return `${process.env.SUPABASE_URL}/storage/v1/object/public/smartlms/print-settings/${folder}/${uniqueFileName}`;
};

exports.updatePrintSetting = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      description,
      headerData,
      pageSettings,
      typography,
      footerSetting,
      watermarkSettings,
      logoSettings
    } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid print setting ID format" }],
      });
    }

    const existing = await PrintSetting.findById(id);
    if (!existing) {
      return res.status(404).json({
        message: [{ key: "error", value: "Print setting not found" }],
      });
    }

    let updateData = {
      title,
      description,
      headerData,
      pageSettings,
      typography: typography || existing.typography || {},
      footerSetting: footerSetting || existing.footerSetting || {},
      watermarkSettings: watermarkSettings || existing.watermarkSettings || {},
      logoSettings: logoSettings || existing.logoSettings || {},
      updatedAt: new Date(),
    };

    // Handle signature updates
    updateData.signature = existing.signature || {};

    if (req.files?.leftLogo) {
      await deleteFromSupabase(
        existing.logoSettings?.leftLogoUrl,
        "logos"
      );
      updateData.logoSettings.leftLogoUrl =
        await uploadToSupabase(req.files.leftLogo, "logos");
    }

    if (req.files?.rightLogo) {
      await deleteFromSupabase(
        existing.logoSettings?.rightLogoUrl,
        "logos"
      );
      updateData.logoSettings.rightLogoUrl =
        await uploadToSupabase(req.files.rightLogo, "logos");
    }

    if (req.files?.signature) {
      await deleteFromSupabase(
        existing.signature?.signatureUrl,
        "signatures"
      );
      updateData.signature.signatureUrl = await uploadToSupabase(
        req.files.signature,
        "signatures"
      );
    }

    if (req.files?.seal) {
      await deleteFromSupabase(existing.signature?.sealUrl, "seals");
      updateData.signature.sealUrl = await uploadToSupabase(
        req.files.seal,
        "seals"
      );
    }

    if (req.files?.watermark) {
      await deleteFromSupabase(
        existing.watermarkSettings?.watermarkUrl,
        "watermarks"
      );
      updateData.watermarkSettings.watermarkUrl = await uploadToSupabase(
        req.files.watermark,
        "watermarks"
      );
    }

    const updated = await PrintSetting.findByIdAndUpdate(id, updateData, {
      new: true,
      runValidators: true,
    });

    return res.status(200).json({
      message: [
        { key: "success", value: "Print setting updated successfully" },
      ],
      data: updated,
    });
  } catch (error) {
    console.error("Error updating print setting:", error);
    return res.status(500).json({
      message: [
        { key: "error", value: "Server error while updating print setting" },
      ],
    });
  }
};

exports.deletePrintSetting = async (req, res) => {
  try {
    const { id } = req.params;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({
        message: [{ key: "error", value: "Invalid print setting ID format" }],
      });
    }

    const existing = await PrintSetting.findById(id);
    if (!existing) {
      return res.status(404).json({
        message: [{ key: "error", value: "Print setting not found" }],
      });
    }

    await deleteFromSupabase(
      existing.logoSettings?.leftLogoUrl,
      "logos"
    );
    await deleteFromSupabase(
      existing.logoSettings?.rightLogoUrl,
      "logos"
    );
    await deleteFromSupabase(
      existing.signature?.signatureUrl,
      "signatures"
    );
    await deleteFromSupabase(existing.signature?.sealUrl, "seals");
    await deleteFromSupabase(
      existing.watermarkSettings?.watermarkUrl,
      "watermarks"
    );

    await PrintSetting.findByIdAndDelete(id);

    return res.status(200).json({
      message: [
        { key: "success", value: "Print setting deleted successfully" },
      ],
    });
  } catch (error) {
    console.error("Error deleting print setting:", error);
    return res.status(500).json({
      message: [
        { key: "error", value: "Server error while deleting print setting" },
      ],
    });
  }
};