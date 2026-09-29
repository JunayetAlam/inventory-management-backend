import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import httpStatus from 'http-status';
import config from '../../../config';
import AppError from '../../errors/AppError';
import { insecurePrisma, prisma } from '../../utils/prisma';
import { generateOTP, otpExpiryTime } from '../../utils/otp';
import { verifyOtp } from '../../utils/verifyOtp';
import { sendOtp } from '../../utils/sendOtp';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { createSessionUtil, resendOtpUtil } from './auth.utils';
import { clearAuthCookies } from '../../utils/cookieOptions';
import {
  destroyAllUserSessions,
  destroySession,
  destroyUserSessionById,
  hashSid,
  listUserSessions,
} from '../../utils/sessions';
import { firebaseAuth } from '../../utils/firebase';
import {
  FirebaseProvider,
  NotificationType,
  User,
  UserRoleEnum,
  UserStatus,
} from '../../../generated/prisma/client';
import { accountAccessMessage } from '../User/user.policy';
import { logActivity } from '../../utils/activityLog';
import { notifyAdmins, sendNotification } from '../../utils/notification';

const RESET_TOKEN_TTL_MS = 10 * 60 * 1000;

const loginWithFirebase = catchAsync(async (req, res) => {
  const { idToken } = req.body;
  let decodedToken;
  try {
    decodedToken = await firebaseAuth.verifyIdToken(idToken);
  } catch (error) {
    throw new AppError(
      httpStatus.UNAUTHORIZED,
      'Invalid or expired Firebase ID token',
    );
  }

  const { uid, email, name, picture, providerId } = decodedToken;
  const firstName = name?.split(' ')[0];
  const lastName = name?.split(' ')[1];

  const normalizedProvider = providerId?.toUpperCase();
  const provider: FirebaseProvider = ['GOOGLE', 'FACEBOOK'].includes(
    normalizedProvider,
  )
    ? (normalizedProvider as FirebaseProvider)
    : FirebaseProvider.GOOGLE;

  if (!email) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Email is required for social login',
    );
  }

  let user = await prisma.user.findUnique({
    where: {
      email: email,
    },
  });

  if (user) {
    if (user.isDeleted) {
      throw new AppError(
        httpStatus.NOT_FOUND,
        'Account has been deleted. Please contact support to reactivate your account',
      );
    }
    if (user.loginWay === 'EMAIL') {
      throw new AppError(
        httpStatus.BAD_REQUEST,
        'Email already in use with different login method',
      );
    }
  } else {
    user = await prisma.user.create({
      data: {
        email: email,
        firstName: firstName || '',
        lastName: lastName || '',
        profilePhoto: picture,
        isAgreeWithTerms: true,
        isEmailVerified: true,
        firebaseProvider: provider,
        firebaseUid: uid,
        loginWay: 'FIREBASE',
        role: UserRoleEnum.CASHIER,
        status: UserStatus.PENDING,
      },
    });

    logActivity({
      userId: user.id,
      action: 'USER_REGISTER_FIREBASE',
      entityType: 'USER',
      entityId: user.id,
      req,
      details: { provider, email: user.email },
    });

    sendNotification({
      userId: user.id,
      title: 'Welcome to Invoice Management System',
      message:
        'Your account has been created via social login and is pending admin approval.',
      type: NotificationType.INFO,
      link: '/profile',
    });

    notifyAdmins({
      title: 'New Social Registration',
      message: `${user.firstName || 'User'} (${user.email}) registered via ${provider}.`,
      type: NotificationType.INFO,
      link: `/users/${user.id}`,
    });
  }

  const accessMessage = accountAccessMessage(user.status);
  if (accessMessage) {
    throw new AppError(httpStatus.FORBIDDEN, accessMessage);
  }

  await createSessionUtil(user as User, req, res);
});

const INVALID_CREDENTIALS = 'Invalid email or password';
const FORGOT_PASSWORD_MESSAGE =
  'If an account exists, a verification code has been sent.';

const loginUser = catchAsync(async (req, res) => {
  const payload = req.body;
  const userData = await insecurePrisma.user.findUnique({
    where: {
      email: payload.email,
    },
  });

  if (!userData || userData.isDeleted || userData.loginWay === 'FIREBASE') {
    throw new AppError(httpStatus.UNAUTHORIZED, INVALID_CREDENTIALS);
  }

  const isCorrectPassword = await bcrypt.compare(
    payload.password,
    userData.password || '',
  );

  if (!isCorrectPassword) {
    throw new AppError(httpStatus.UNAUTHORIZED, INVALID_CREDENTIALS);
  }

  if (userData.role !== 'SUPERADMIN' && !userData.isEmailVerified) {
    await resendOtpUtil(userData.email);
    sendResponse(res, {
      statusCode: httpStatus.OK,
      message: 'Please verify your email. A verification code has been sent.',
      data: {
        message: 'Please verify your email. A verification code has been sent.',
      },
    });
    return;
  }

  const accessMessage = accountAccessMessage(userData.status);
  if (accessMessage) {
    throw new AppError(httpStatus.FORBIDDEN, accessMessage);
  }

  await createSessionUtil(userData, req, res);
});

const registerUser = catchAsync(async (req, res) => {
  const payload = req.body;
  delete payload.role;
  const hashedPassword: string = await bcrypt.hash(
    payload.password,
    Number(config.bcrypt_salt_rounds) || 12,
  );

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

  const otp = generateOTP();

  const createdUser = await prisma.user.create({
    data: {
      firstName: payload.firstName,
      lastName: payload.lastName,
      email: payload.email,
      phoneNumber: payload.phoneNumber,
      password: hashedPassword,
      isAgreeWithTerms: payload.isAgreeWithTerms,
      role: UserRoleEnum.CASHIER,
      status: UserStatus.PENDING,
      otp: hashSid(otp),
      otpExpiry: otpExpiryTime(),
      otpAttempts: 0,
      otpFor: 'USER_VERIFICATION',
    },
  });

  logActivity({
    userId: createdUser.id,
    action: 'USER_REGISTER',
    entityType: 'USER',
    entityId: createdUser.id,
    req,
    details: { email: payload.email, phoneNumber: payload.phoneNumber },
  });

  sendNotification({
    userId: createdUser.id,
    title: 'Welcome to Invoice Management System',
    message:
      'Your account has been registered. Please verify your email using the OTP code.',
    type: NotificationType.INFO,
    link: '/profile',
  });

  notifyAdmins({
    title: 'New User Registered',
    message: `${payload.firstName} ${payload.lastName} (${payload.email}) registered an account.`,
    type: NotificationType.INFO,
    link: `/users/${createdUser.id}`,
  });

  if (config.env === 'development') {
    console.log(`[DEV OTP] ${payload.email} => ${otp}`);
  }

  try {
    await sendOtp({ email: payload.email, otp });
  } catch (mailErr) {
    if (config.env === 'development') {
      console.error(
        '[EMAIL] SMTP failed during register. Update MAIL / MAIL_PASS with a valid Gmail App Password.',
        mailErr,
      );
      sendResponse(res, {
        statusCode: httpStatus.CREATED,
        message:
          'Account created, but email could not be sent. Check MAIL_PASS (Gmail App Password).',
        data: {
          message: 'Please check your email to verify your account',
        },
      });
      return;
    }
    throw mailErr;
  }

  sendResponse(res, {
    statusCode: httpStatus.CREATED,
    message: 'User Register Successfully. Check your mail to verify',
    data: {
      message: 'Please check your Email to verify your account',
    },
  });
});

const verifyEmail = catchAsync(async (req, res) => {
  const { email, otp } = req.body;
  const { userData } = await verifyOtp({ email, otp }, 'USER_VERIFICATION');
  await prisma.user.update({
    where: {
      email: userData.email,
    },
    data: {
      otp: null,
      otpExpiry: null,
      isEmailVerified: true,
      otpFor: 'NOT',
      otpAttempts: 0,
    },
    select: {
      id: true,
    },
  });

  logActivity({
    userId: userData.id,
    action: 'USER_VERIFY_EMAIL',
    entityType: 'USER',
    entityId: userData.id,
    req,
    details: { email: userData.email },
  });

  sendNotification({
    userId: userData.id,
    title: 'Email Verified',
    message:
      'Your email has been verified successfully. Your account is pending admin approval.',
    type: NotificationType.SUCCESS,
    link: '/profile',
  });

  notifyAdmins({
    title: 'User Email Verified',
    message: `${userData.firstName} ${userData.lastName} (${userData.email}) verified their email.`,
    type: NotificationType.INFO,
    link: `/users/${userData.id}`,
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message:
      'Email verified successfully. Your account is pending admin approval.',
    data: {
      pendingApproval: true,
      email: userData.email,
    },
  });
});

const resendVerificationOtpToNumber = catchAsync(async (req, res) => {
  const { email } = req.body;
  const result = await resendOtpUtil(email);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: result.message,
    data: {
      message: result.message,
    },
  });
});

const changePassword = catchAsync(async (req, res) => {
  const { user } = req;
  const payload = req.body;
  const userData = await insecurePrisma.user.findUniqueOrThrow({
    where: {
      email: user.email,
      status: 'ACTIVE',
    },
  });

  if (userData.isDeleted) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      'Account has been deleted. Please contact support to reactivate your account',
    );
  }

  if (userData.status === 'BLOCKED') {
    throw new AppError(httpStatus.FORBIDDEN, 'Account has been blocked');
  }

  if (userData.loginWay === 'FIREBASE') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Email already in use with different login method',
    );
  }

  const isCorrectPassword: boolean = await bcrypt.compare(
    payload.oldPassword,
    userData.password || '',
  );

  if (!isCorrectPassword) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Old Password is incorrect');
  }

  const hashedPassword: string = await bcrypt.hash(payload.newPassword, 12);

  await prisma.user.update({
    where: {
      id: userData.id,
    },
    data: {
      password: hashedPassword,
    },
  });

  await destroyAllUserSessions(userData.id);
  clearAuthCookies(res);

  logActivity({
    userId: userData.id,
    action: 'USER_CHANGE_PASSWORD',
    entityType: 'USER',
    entityId: userData.id,
    req,
  });

  sendNotification({
    userId: userData.id,
    title: 'Password Changed',
    message: 'Your password was changed successfully.',
    type: NotificationType.WARNING,
    link: '/profile',
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    data: {
      message: 'Password changed successfully!',
    },
  });
});

const forgetPassword = catchAsync(async (req, res) => {
  const { email } = req.body;
  const user = await insecurePrisma.user.findUnique({
    where: {
      email: email,
    },
  });

  if (
    user &&
    user.isEmailVerified &&
    !user.isDeleted &&
    user.status !== 'BLOCKED' &&
    user.loginWay !== 'FIREBASE'
  ) {
    const otp = generateOTP();

    if (config.env === 'development') {
      console.log(`[DEV OTP] ${email} => ${otp}`);
    }

    await prisma.user.update({
      where: { email: email },
      data: {
        otp: hashSid(otp),
        otpExpiry: otpExpiryTime(),
        otpFor: 'FORGOT_PASSWORD',
        otpAttempts: 0,
      },
    });

    await sendOtp({ email: user.email, otp });
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    data: {
      message: FORGOT_PASSWORD_MESSAGE,
    },
  });
});

const verifyForgotPassOtp = catchAsync(async (req, res) => {
  const payload = req.body;

  await verifyOtp(payload, 'FORGOT_PASSWORD');
  const resetToken = randomBytes(32).toString('hex');

  await prisma.user.update({
    where: {
      email: payload.email,
    },
    data: {
      otp: null,
      otpExpiry: null,
      passwordResetToken: hashSid(resetToken),
      passwordResetTokenExpires: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      otpFor: 'NOT',
      otpAttempts: 0,
    },
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'OTP verified successfully',
    data: { resetToken, expireInMinutes: 10 },
  });
});

const resetPassword = catchAsync(async (req, res) => {
  const payload = req.body;
  const token = payload.token;
  if (!token) {
    throw new AppError(httpStatus.FORBIDDEN, 'Token is missing!');
  }

  const userData = await insecurePrisma.user.findFirstOrThrow({
    where: {
      email: payload.email,
    },
  });

  if (userData.loginWay === 'FIREBASE') {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      'Email already in use with different login method',
    );
  }

  if (
    !userData.passwordResetToken ||
    !userData.passwordResetTokenExpires ||
    userData.passwordResetTokenExpires < new Date() ||
    hashSid(token) !== userData.passwordResetToken
  ) {
    throw new AppError(httpStatus.FORBIDDEN, 'Invalid token');
  }

  if (userData.isDeleted) {
    throw new AppError(
      httpStatus.NOT_FOUND,
      'Account has been deleted. Please contact support to reactivate your account',
    );
  }

  if (userData.status === 'BLOCKED') {
    throw new AppError(httpStatus.FORBIDDEN, 'User has blocked');
  }

  const newHashedPassword = await bcrypt.hash(
    payload.newPassword,
    Number(config.bcrypt_salt_rounds),
  );

  await prisma.user.update({
    where: {
      email: payload.email,
    },
    data: {
      password: newHashedPassword,
      passwordResetToken: null,
      passwordResetTokenExpires: null,
    },
  });

  await destroyAllUserSessions(userData.id);

  logActivity({
    userId: userData.id,
    action: 'USER_RESET_PASSWORD',
    entityType: 'USER',
    entityId: userData.id,
    req,
  });

  sendNotification({
    userId: userData.id,
    title: 'Password Reset Successful',
    message: 'Your account password has been reset successfully.',
    type: NotificationType.WARNING,
    link: '/profile',
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    data: { message: 'Password reset successfully' },
  });
});

const logoutUser = catchAsync(async (req, res) => {
  const sid = req.cookies?.[config.session.cookie_name] as string | undefined;

  if (req.user?.id) {
    logActivity({
      userId: req.user.id,
      action: 'USER_LOGOUT',
      entityType: 'USER',
      entityId: req.user.id,
      req,
    });
  }

  await destroySession(sid);
  clearAuthCookies(res);
  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'User logged out successfully',
    data: '',
  });
});

const getLoggedInDevices = catchAsync(async (req, res) => {
  const sid = req.cookies?.[config.session.cookie_name] as string | undefined;
  const currentHash = sid ? hashSid(sid) : null;
  const sessions = await listUserSessions(req.user.id);

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: 'Logged in devices retrieved successfully',
    data: sessions.map(({ tokenHash, ...device }) => ({
      ...device,
      isCurrent: Boolean(currentHash && tokenHash === currentHash),
    })),
  });
});

const removeDevice = catchAsync(async (req, res) => {
  const sid = req.cookies?.[config.session.cookie_name] as string | undefined;
  const session = await destroyUserSessionById(req.user.id, req.params.id);

  if (!session) {
    throw new AppError(httpStatus.NOT_FOUND, 'Device session not found');
  }

  const isCurrent = Boolean(sid && hashSid(sid) === session.tokenHash);
  if (isCurrent) {
    clearAuthCookies(res);
  }

  logActivity({
    userId: req.user.id,
    action: 'USER_REVOKE_DEVICE',
    entityType: 'SESSION',
    entityId: session.id,
    req,
    details: { sessionId: session.id },
  });

  sendNotification({
    userId: req.user.id,
    title: 'Device Removed',
    message: 'A device session was removed from your account.',
    type: NotificationType.INFO,
    link: '/profile',
  });

  sendResponse(res, {
    statusCode: httpStatus.OK,
    message: isCurrent
      ? 'Current device logged out successfully'
      : 'Device removed successfully',
    data: { id: session.id, isCurrent },
  });
});

export const AuthServices = {
  loginWithFirebase,
  loginUser,
  registerUser,
  changePassword,
  forgetPassword,
  resetPassword,
  resendVerificationOtpToNumber,
  verifyEmail,
  verifyForgotPassOtp,
  logoutUser,
  getLoggedInDevices,
  removeDevice,
};
