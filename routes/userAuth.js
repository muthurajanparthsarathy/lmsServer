const express = require('express')
const router = express.Router()

const {
  Addusers,
  UserSignIn,
  getUserAccess,
  getUserAccessById,
  UserVerify,
  verifyToken,
  UpdateUser,
  DeleteUser,
  UserLogout,
  UserLogoutAll,
  getAllTokens,
  toggleUserStatus,
  bulkToggleUserStatus,
  bulkUploadUsers,
  UpdateUserWithPermission,
  GetMyPermission,
  GetUserPermission,
  bulkUpdatePermissions,


} = require('../controllers/userAuth.js')

const { userAuth } = require('../middlewares/userAuth.js')
const { userRole } = require('../middlewares/userRole.js')


router.post('/add/users',userAuth, Addusers)
router.post('/user/login', UserSignIn)
// router.get('/user/token', getAllTokens)

router.get('/getAll/userAccess/:instutionId',userAuth, getUserAccess);
router.post('/user/verify-token', verifyToken, (req, res) => {
  res.status(200).json({ valid: true, user: req.user });
});

router.post('/logout',userAuth, UserLogout);
router.post('/logout-all',userAuth, UserLogoutAll);
router.get('/getById/userAccess/:id',userAuth, getUserAccessById);
router.get('/user/Verify', userAuth, UserVerify) // for testing only

router.put('/update/users/:userId',userAuth, UpdateUser);
router.delete('/delete/users/:userId',userAuth, DeleteUser)


router.put("/user/status/:userId",userAuth,  toggleUserStatus);

router.put("/user/bulk-status",userAuth,  bulkToggleUserStatus);


router.post('/user/bulk-upload-users',userAuth, bulkUploadUsers)


router.put("/user-permission/update/:userId",userAuth, UpdateUserWithPermission);
router.put("/user-permission/bulk-update",userAuth, bulkUpdatePermissions);

router.get("/my-permission",userAuth, GetMyPermission);

router.get("/user/get-permission/:userId", userAuth, GetUserPermission);



module.exports = router
