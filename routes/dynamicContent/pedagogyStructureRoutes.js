const express = require('express');
const { userAuth } = require('../../middlewares/userAuth');
const { createPedagogyStructure, getAllPedagogyStructures, getPedagogyStructureById, updateArrayElement, deleteArrayElement } = require('../../controllers/dynamicContent/pedagogyStructure');
const router = express.Router();


router.post('/dynamic/pedagogy/create',userAuth, createPedagogyStructure);

router.get('/dynamic/pedagogy/getAll',userAuth, getAllPedagogyStructures);

router.get('/dynamic/pedagogy/getById/:id',userAuth, getPedagogyStructureById);

router.put('/dynamic/pedagogy/update/:id',userAuth, updateArrayElement);

router.delete('/dynamic/pedagogy/delete/:id',userAuth, deleteArrayElement);

module.exports = router;