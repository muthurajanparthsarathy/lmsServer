// Pre-existing LMS-Institution documents that are conceptually clients, not
// platform tenants — per business decision, only SmartCliff is a real
// institution today. Hidden from every Super Admin module (Institutions,
// Roles, Users, ...) without touching the underlying documents or any
// existing LMS-User/Role/Course record that references them. Reversible —
// remove an id here to make it visible again.
// All institutions are now shown across every Super Admin module. The set is
// intentionally empty so isHiddenInstitution() always returns false. To hide a
// tenant again, add its _id back below.
const HIDDEN_INSTITUTION_IDS = new Set([
  // "693540e6b81e809c9d4c2a46", // Rooban Own
  // "68677130fa6b228f5bccccb1", // KIOT College
  // "686b495d972fac51432c31dd", // KIOT
  // "6909820ad674bf8e94c19ce6", // RVS College
  // "696e0695d744732a85dabc44", // Peelamedu Samanaidu Govindasamy College Of Technology
]);

const isHiddenInstitution = (id) => HIDDEN_INSTITUTION_IDS.has(String(id));

module.exports = { HIDDEN_INSTITUTION_IDS, isHiddenInstitution };
