const Institution = require("../models/InstitutionModal");
const InstitutionPermission = require("../models/superadmin/InstitutionPermissionModel");
const ResourceSetting = require("../models/superadmin/ResourceSettingModel");
// const { createClient } = require("@supabase/supabase-js");
// const supabaseKey = process.env.SUPABASE_KEY;
// const supabaseUrl = process.env.SUPABASE_URL;

// const supabase = createClient(supabaseUrl, supabaseKey);

exports.createInstitution = async (req, res) => {
  try {
      const { inst_name, inst_owner, phone, address,basedOn, createdBy } = req.body;

      const existingInstitution = await Institution.findOne({ inst_name });
      if (existingInstitution) {
          return res.status(403).json({ message: [{ key: "error", value: "Institution Name already exists" }] });
      }

      if (!inst_name || !inst_owner || !phone) {
          return res.status(400).json({ message: [{ key: "error", value: "Required fields" }] });
      }

      const lastInstitution = await Institution.findOne().sort({ inst_id: -1 }).limit(1);

      let inst_id = 'INS001';
      if (lastInstitution && lastInstitution.inst_id) {
          const lastIdMatch = lastInstitution.inst_id.match(/INS(\d+)/);
          if (lastIdMatch && lastIdMatch[1]) {
              const lastIdNumericPart = parseInt(lastIdMatch[1], 10);
              if (!isNaN(lastIdNumericPart)) {
                  inst_id = 'INS' + String(lastIdNumericPart + 1).padStart(3, '0');
              }
          }
      }

      const newInstitution = new Institution({
          inst_id,
          inst_name,
          phone,
          inst_owner,
          address,
          basedOn,
          createdBy: req?.user?.email || "roobankr5@gmail.com", // Uncomment and modify as needed for actual user context
      });

      // Save new institution
      await newInstitution.save();

      // Return success response
      return res.status(201).json({ message: [{ key: "Success", value: "Institution Added Successfully" }] });
  } catch (error) {
      console.error(error);
      return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};


exports.getAllInstitution= async (req, res) => {
    try {
      const institutions = await Institution.find();
  
      
      return res.status(200).json({
        message: [{ key: 'success', value: 'Institution Retrieved successfully' }],
        getAllInstitution: institutions,
      });
    } catch (error) {
      return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
    }
  };


  exports.getInstitutionById = async (req, res) => {
    const { id } = req.params;
    try {
      const institutions = await Institution.findById(id);
  
      if (!institutions) {
        return res.status(404).json({ message: [{ key: 'error', value: 'Role not found' }] });
      }
     
      return res.status(200).json({
        message: [{ key: 'success', value: 'Institution retrieved Id Based successfully' }],
        InstitutionById: institutions
      });
    } catch (error) {
      console.error("Error retrieving Institution by ID:", error);
      return res.status(500).json({ message: [{ key: 'error', value: 'Internal server error' }] });
    }
  };


  exports.updateInstitution = async (req, res) => {
    const { id } = req.params;
    const { inst_name, inst_owner, phone, address,basedOn } = req.body;

    try {
        const institution = await Institution.findById(id);
        if (!institution) {
            return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
        }

        institution.inst_name = inst_name || institution.inst_name;
        institution.inst_owner = inst_owner || institution.inst_owner;
        institution.phone = phone || institution.phone;
        institution.address = address || institution.address;
        institution.basedOn = basedOn || institution.basedOn;
        // institution.lastModifiedBy = req.user.email; // Optional: Track who modified the record
        // institution.lastModifiedOn = Date.now(); // Optional: Track when the record was modified

        await institution.save();

        return res.status(200).json({
            message: [{ key: "success", value: "Institution updated successfully" }],
            updated_institution: institution
        });
    } catch (error) {
        console.error("Error updating institution:", error);
        return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
    }
};

// GET /institution/permissions/:id
// Self-service, read-only mirror of the Super Admin's institution permission
// allow-list (superadmin/institutions/:id/permissions). Lets an institution's
// own logged-in user (e.g. its super_admin) fetch the set of permissions the
// Super Admin enabled for their institution, so the LMS-side Permission Modal
// can limit what it offers instead of showing the full catalog. A user may
// only read their own institution's list — never another tenant's.
exports.getInstitutionPermissions = async (req, res) => {
  const { id } = req.params;
  try {
    if (String(req.user?.institution) !== String(id)) {
      return res.status(403).json({ message: [{ key: "error", value: "Not allowed to view this institution's permissions" }] });
    }
    const doc = await InstitutionPermission.findOne({ institution: id }).lean();
    return res.status(200).json({
      message: [{ key: "success", value: "Institution permissions retrieved" }],
      permissions: doc?.permissions || [],
    });
  } catch (error) {
    console.error("Error retrieving institution permissions:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// GET /institution/resource-settings/:id
// Self-service, read-only mirror of the Super Admin's Resource Management
// config (superadmin/resources). Lets an institution's own logged-in user
// read which I Do upload types (ppt/pdf/videos/image/zip/url/notes/ai) and
// We Do / You Do AI features the Super Admin enabled, so the course-creation
// "Resource Type" step can show only what's actually available instead of
// every possible type. A user may only read their own institution's config.
exports.getInstitutionResourceSettings = async (req, res) => {
  const { id } = req.params;
  try {
    if (String(req.user?.institution) !== String(id)) {
      return res.status(403).json({ message: [{ key: "error", value: "Not allowed to view this institution's resource settings" }] });
    }
    const doc = await ResourceSetting.findOne({ scope: String(id) }).lean();
    // No doc yet (Super Admin never opened Resource Management for this
    // institution) → fall back to the schema's defaults, same as what the
    // Super Admin would see on first load.
    const resourcePedagogy = doc?.resourcePedagogy || new ResourceSetting({}).toObject().resourcePedagogy;
    return res.status(200).json({
      message: [{ key: "success", value: "Resource settings retrieved" }],
      resourcePedagogy,
    });
  } catch (error) {
    console.error("Error retrieving institution resource settings:", error);
    return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
  }
};

// Delete Institution
exports.deleteInstitution = async (req, res) => {
    const { id } = req.params;
  
    try {
      const institutions = await Institution.findById(id);
  
      if (!institutions) {
        return res.status(404).json({ message: [{ key: "error", value: "Institution not found" }] });
      }
        await Institution.findByIdAndDelete(id);
  
      return res.status(200).json({ message: [{ key: "success", value: "Institution deleted successfully" }] });
    } catch (error) {
      console.error("Error deleting Institution:", error);
      return res.status(500).json({ message: [{ key: "error", value: "Internal server error" }] });
    }
  };
