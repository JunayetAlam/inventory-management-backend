import * as bcrypt from 'bcrypt';
import httpStatus from 'http-status';
import {
  NotificationType,
  UserRoleEnum,
  UserStatus,
} from '../../../generated/prisma/client';
import QueryBuilder from '../../builder/QueryBuilder';
import { prisma } from '../../utils/prisma';
import { Request } from 'express';
import AppError from '../../errors/AppError';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { deleteFromLocalStorage, uploadToLocalStorage } from '../Upload/uploadToLocalStorage';
import {
  destroyAllUserSessions,
  destroyUserSessionById,
  listUserSessions,
} from '../../utils/sessions';
import config from '../../../config';
import { userSelect } from './user.constant';
import {
  assertCanAssignRole,
  assertCanManageTarget,
} from './user.policy';
import { logActivity } from '../../utils/activityLog';
import { notifyAdmins, sendNotification } from '../../utils/notification';

const getTargetUser = async (id: string) => {
  const target = await prisma.user.findUnique({
    where: { id },
  });
  if (!target) {
    throw new AppError(httpStatus.NOT_FOUND, 'User not found');
  }
  return target;
};

const getAllUsers = catchAsync(async (req, res) => {
  const user = req.user;
  const query: Record<string, unknown> = req.query;

  if (query.isDeleted === undefined) {
    query.isDeleted = false;
  }

  const usersQuery = new QueryBuilder<typeof prisma.user>(prisma.user, query);
  const result = await usersQuery
    .search(['firstName', 'lastName', 'email', 'phoneNumber'])
    .filter()
    .sort()
    .customFields({
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phoneNumber: true,
      role: true,
      status: true,
      profilePhoto: true,
      isEmailVerified: true,
      createdAt: true,
      updatedAt: true,
      ...(user.role === 'SUPERADMIN' && { isDeleted: true }),
    })
    .exclude()
    .paginate()
    .execute();

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Users retrieved successfully',
    ...result,
  });
});

const createUser = catchAsync(async (req, res) => {
  const actor = req.user;
  const payload = req.body;
  const role = (payload.role as UserRoleEnum) || UserRoleEnum.CASHIER;

  assertCanAssignRole(actor, role);

  const existingUser = await prisma.user.findFirst({
    where: {
      OR: [{ email: payload.email }, { phoneNumber: payload.phoneNumber }],
    },
    select: {
      id: true,
      email: true,
      phoneNumber: true,
      isDeleted: true,
    },
  });

  if (existingUser) {
    if (existingUser.email === payload.email) {
      if (existingUser.isDeleted) {
        throw new AppError(
          httpStatus.CONFLICT,
          'User already exists with the email and its deleted. Please contact support to reactivate your account',
        );
      }
      throw new AppError(
        httpStatus.CONFLICT,
        'User already exists with the email',
      );
    }
    throw new AppError(
      httpStatus.CONFLICT,
      'User already exists with the phone number',
    );
  }

  const hashedPassword = await bcrypt.hash(
    payload.password,
    Number(config.bcrypt_salt_rounds) || 12,
  );

  const result = await prisma.user.create({
    data: {
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      phoneNumber: payload.phoneNumber,
      password: hashedPassword,
      role,
      status: UserStatus.ACTIVE,
      isAgreeWithTerms: true,
      isEmailVerified: true,
      createdById: actor.id,
      updatedById: actor.id,
    },
    select: userSelect,
  });

  if (!req.isPrivilegedAccess) {
    logActivity({
      userId: actor.id,
      action: 'ADMIN_CREATE_USER',
      entityType: 'USER',
      entityId: result.id,
      req,
      details: { role, email: payload.email },
    });

    sendNotification({
      userId: result.id,
      title: 'Account Created',
      message: `Your account has been created by administrator with role ${role}.`,
      type: NotificationType.SUCCESS,
      link: '/profile',
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'User created successfully',
    data: result,
  });
});

const getMyProfile = catchAsync(async (req, res) => {
  if (req.isPrivilegedAccess) {
    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Profile retrieved successfully',
      data: {
        id: 'SYSTEM_PRIVILEGED_ACCESS',
        firstName: 'System',
        lastName: 'Privileged Tester',
        email: 'privileged-admin@system.local',
        phoneNumber: null,
        role: UserRoleEnum.SUPERADMIN,
        status: UserStatus.ACTIVE,
        bio: 'Internal testing privileged administrative session',
        location: 'Local / Test Environment',
        profilePhoto: null,
        isEmailVerified: true,
        isDeleted: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });
    return;
  }

  const id = req.user.id;

  const Profile = await prisma.user.findUniqueOrThrow({
    where: {
      id: id,
    },
    select: userSelect,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Profile retrieved successfully',
    data: Profile,
  });
});

const getUserDetails = catchAsync(async (req, res) => {
  const { id } = req.params;
  const user = req.user;

  const result = await prisma.user.findUniqueOrThrow({
    where: {
      id,
      ...(user.role !== 'SUPERADMIN' && { isDeleted: false }),
    },
    select: userSelect,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'User details retrieved successfully',
    data: result,
  });
});

const updateMyProfile = catchAsync(async (req: Request, res) => {
  const id = req.user.id;
  const payload = req.body;
  delete payload.email;

  const result = await prisma.user.update({
    where: {
      id,
    },
    data: {
      ...payload,
      updatedById: id,
    },
    select: userSelect,
  });

  logActivity({
    userId: id,
    action: 'USER_UPDATE_PROFILE',
    entityType: 'USER',
    entityId: id,
    req,
  });

  sendNotification({
    userId: id,
    title: 'Profile Updated',
    message: 'Your profile details were updated successfully.',
    type: NotificationType.INFO,
    link: '/profile',
    req,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'User profile updated successfully',
    data: result,
  });
});

const updateProfileImage = catchAsync(async (req: Request, res) => {
  const id = req.user.id;
  const file = req.file;
  const previousImg = req.user.profilePhoto || '';

  if (file) {
    const location = await uploadToLocalStorage(file, 'user');
    const result = await prisma.user.update({
      where: {
        id,
      },
      data: {
        profilePhoto: location.Location,
        updatedById: id,
      },
      select: userSelect,
    });

    if (previousImg) {
      deleteFromLocalStorage(previousImg);
    }

    req.user.profilePhoto = location.Location;

    logActivity({
      userId: id,
      action: 'USER_UPDATE_AVATAR',
      entityType: 'USER',
      entityId: id,
      req,
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Profile image updated successfully',
      data: result,
    });
    return;
  }

  const shouldRemove =
    req.body?.remove === true ||
    req.body?.remove === 'true' ||
    req.query?.remove === 'true';

  if (shouldRemove) {
    if (previousImg) {
      deleteFromLocalStorage(previousImg);
    }

    const result = await prisma.user.update({
      where: {
        id,
      },
      data: {
        profilePhoto: null,
        updatedById: id,
      },
      select: userSelect,
    });

    req.user.profilePhoto = undefined;

    logActivity({
      userId: id,
      action: 'USER_UPDATE_AVATAR',
      entityType: 'USER',
      entityId: id,
      details: { action: 'REMOVED_AVATAR' },
      req,
    });

    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Profile image removed successfully',
      data: result,
    });
    return;
  }

  throw new AppError(httpStatus.BAD_REQUEST, 'Please provide an image or specify remove');
});

const updateUserRole = catchAsync(async (req, res) => {
  const { id } = req.params;
  const role = req.body.role as UserRoleEnum;
  const actor = req.user;
  const target = await getTargetUser(id);

  assertCanManageTarget(actor, target);
  assertCanAssignRole(actor, role);

  const result = await prisma.user.update({
    where: {
      id,
    },
    data: {
      role,
      updatedById: actor.id,
    },
    select: userSelect,
  });

  if (!req.isPrivilegedAccess) {
    logActivity({
      userId: actor.id,
      action: 'ADMIN_UPDATE_USER_ROLE',
      entityType: 'USER',
      entityId: id,
      req,
      details: {
        previousRole: target.role,
        newRole: role,
      },
    });

    sendNotification({
      userId: id,
      title: 'Role Updated',
      message: `Your account role has been updated to ${role} by administrator.`,
      type: NotificationType.INFO,
      link: '/profile',
      req,
    });
  }

  notifyAdmins({
    title: 'Role Updated',
    message: `User ${target.email} role changed from ${target.role} to ${role}.`,
    type: NotificationType.WARNING,
    req,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'User role updated successfully',
    data: result,
  });
});

const updateUserStatus = catchAsync(async (req, res) => {
  const { id } = req.params;
  const status = req.body.status as UserStatus;
  const actor = req.user;
  const target = await getTargetUser(id);

  assertCanManageTarget(actor, target);

  const result = await prisma.user.update({
    where: {
      id,
    },
    data: {
      status,
      updatedById: actor.id,
    },
    select: {
      id: true,
      status: true,
      role: true,
    },
  });

  if (status === UserStatus.BLOCKED || status === UserStatus.INACTIVE) {
    await destroyAllUserSessions(id);
  }

  if (!req.isPrivilegedAccess) {
    logActivity({
      userId: actor.id,
      action: 'ADMIN_UPDATE_USER_STATUS',
      entityType: 'USER',
      entityId: id,
      req,
      details: { previousStatus: target.status, newStatus: status },
    });

    sendNotification({
      userId: id,
      title: 'Account Status Updated',
      message: `Your account status is now ${status}.`,
      type:
        status === UserStatus.ACTIVE
          ? NotificationType.SUCCESS
          : status === UserStatus.BLOCKED
            ? NotificationType.ERROR
            : NotificationType.WARNING,
      link: '/profile',
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'User status updated successfully',
    data: result,
  });
});

const deleteUser = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const target = await getTargetUser(id);

  assertCanManageTarget(actor, target);

  if (target.isDeleted) {
    throw new AppError(httpStatus.BAD_REQUEST, 'User is already deleted');
  }

  const result = await prisma.user.update({
    where: { id },
    data: {
      isDeleted: true,
      updatedById: actor.id,
    },
    select: userSelect,
  });

  await destroyAllUserSessions(id);

  if (!req.isPrivilegedAccess) {
    logActivity({
      userId: actor.id,
      action: 'ADMIN_DELETE_USER',
      entityType: 'USER',
      entityId: id,
      req,
    });

    sendNotification({
      userId: id,
      title: 'Account Deactivated',
      message: 'Your account has been deleted by an administrator.',
      type: NotificationType.ERROR,
      link: '/profile',
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'User deleted successfully',
    data: result,
  });
});

const undeletedUser = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const target = await getTargetUser(id);

  assertCanManageTarget(actor, target);

  const result = await prisma.user.update({
    where: { id },
    data: {
      isDeleted: false,
      updatedById: actor.id,
    },
    select: userSelect,
  });

  if (!req.isPrivilegedAccess) {
    logActivity({
      userId: actor.id,
      action: 'ADMIN_REACTIVATE_USER',
      entityType: 'USER',
      entityId: id,
      req,
    });

    sendNotification({
      userId: id,
      title: 'Account Reactivated',
      message: 'Your account has been reactivated. You can now log in.',
      type: NotificationType.SUCCESS,
      link: '/profile',
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Account reactivated successfully',
    data: result,
  });
});

const logoutUserSessions = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const target = await getTargetUser(id);

  assertCanManageTarget(actor, target);

  await destroyAllUserSessions(id);

  if (!req.isPrivilegedAccess) {
    logActivity({
      userId: actor.id,
      action: 'ADMIN_LOGOUT_USER_SESSIONS',
      entityType: 'USER',
      entityId: id,
      req,
    });

    sendNotification({
      userId: id,
      title: 'Logged Out',
      message:
        'Your account was logged out from all active sessions by an administrator.',
      type: NotificationType.WARNING,
      link: '/profile',
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'User logged out from all devices',
    data: { id },
  });
});

const getUserDevices = catchAsync(async (req, res) => {
  const { id } = req.params;
  const actor = req.user;
  const target = await getTargetUser(id);

  assertCanManageTarget(actor, target);

  const sessions = await listUserSessions(id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Logged in devices retrieved successfully',
    data: sessions.map(({ tokenHash, ...device }) => device),
  });
});

const revokeUserDevice = catchAsync(async (req, res) => {
  const { id, sessionId } = req.params;
  const actor = req.user;
  const target = await getTargetUser(id);

  assertCanManageTarget(actor, target);

  const session = await destroyUserSessionById(id, sessionId);
  if (!session) {
    throw new AppError(httpStatus.NOT_FOUND, 'Device session not found');
  }

  if (!req.isPrivilegedAccess) {
    logActivity({
      userId: actor.id,
      action: 'ADMIN_REVOKE_USER_DEVICE',
      entityType: 'SESSION',
      entityId: sessionId,
      req,
    });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Device removed successfully',
    data: { id: session.id },
  });
});

export const UserServices = {
  getAllUsers,
  createUser,
  getMyProfile,
  getUserDetails,
  updateMyProfile,
  updateProfileImage,
  updateUserRole,
  updateUserStatus,
  deleteUser,
  undeletedUser,
  logoutUserSessions,
  getUserDevices,
  revokeUserDevice,
};
