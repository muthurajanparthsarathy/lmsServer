const express = require("express");
const { userAuth } = require("../../middlewares/userAuth");
const { createModuleStructure, getAllModuleStructures, getModuleStructureById, updateModuleStructure, deleteModuleStructure, addElementToModuleStructure, updateElementInModuleStructure, deleteElementFromModuleStructure } = require("../../controllers/courses/moduleStructure");
const router = express.Router();

// Add these to your routes file
router.post("/module-structure/create", userAuth, createModuleStructure);

router.post("/add-element",userAuth, addElementToModuleStructure);
router.put("/update-element",userAuth, updateElementInModuleStructure);

router.delete('/delete-element', userAuth,deleteElementFromModuleStructure);

router.get('/module-structure/getAll', getAllModuleStructures);
router.get('/module-structure/getById/:id', getModuleStructureById);
router.put('/module-structure/update/:id',userAuth, updateModuleStructure);
router.delete('/module-structure/delete/:id',userAuth, deleteModuleStructure);




module.exports = router;
