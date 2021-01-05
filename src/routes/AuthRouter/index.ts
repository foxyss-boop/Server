import { hash, verify } from 'argon2';
import { Request, Response, Router } from 'express';
import { sign } from 'jsonwebtoken';
import { v4 as uuid } from 'uuid';
import { generateString } from '../../utils/GenerateUtil';
import { sendVerificationEmail } from '../../utils/MailUtil';
import { verify as verifyjwt } from 'jsonwebtoken';
import ValidationMiddleware from '../../middlewares/ValidationMiddleware';
import InviteModel from '../../models/InviteModel';
import UserModel from '../../models/UserModel';
import LoginSchema from '../../schemas/LoginSchema';
import RegisterSchema from '../../schemas/RegisterSchema';
import VerifyEmailSchema from '../../schemas/VerifyEmailSchema';
import DiscordRouter from './DiscordRouter';
import PasswordResetsRouter from './PasswordResetsRouter';
import PasswordResetModel from '../../models/PasswordResetModel';
import CounterModel from '../../models/CounterModel';
import RefreshTokenModel from '../../models/RefreshTokenModel';
const router = Router();

async function getNextUid() {
    const { count } = await CounterModel.findByIdAndUpdate('counter', {
        $inc: {
            count: 1,
        },
    });

    return count;
}

router.use('/discord', DiscordRouter);
router.use('/password_resets', PasswordResetsRouter);

router.post('/token', async (req: Request, res: Response) => {
    const cookie = req.cookies['x-refresh-token'];

    if (!cookie) return res.status(401).json({
        success: false,
        error: 'provide a refresh token',
    });

    try {
        const refreshToken = await RefreshTokenModel.findOne({ token: cookie });

        if (!refreshToken || Date.now() >= new Date(refreshToken.expires).getTime()) {
            if (refreshToken) await refreshToken.remove();

            res.status(401).json({
                success: false,
                error: 'invalid refresh token',
            });

            return;
        }

        const token: any = verifyjwt(refreshToken.token, process.env.REFRESH_TOKEN_SECRET);

        const user = await UserModel.findOne({ _id: token._id })
            .select('-__v -password');

        if (!user) return res.status(401).json({
            success: false,
            error: 'invalid refresh token',
        });

        await UserModel.findByIdAndUpdate(user._id, {
            lastLogin: new Date(),
        });

        const accessToken = sign({ _id: user._id }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '15m' });

        res.status(200).json({
            success: true,
            accessToken,
            user,
        });
    } catch (err) {
        res.status(401).json({
            success: false,
            error: 'invalid refresh token',
        });
    }
});

router.post('/register', ValidationMiddleware(RegisterSchema), async (req: Request, res: Response) => {
    let { email, username, password, invite }: {
        email: string;
        username: string;
        password: string;
        invite: string;
    } = req.body;

    if (req.user) return res.status(400).json({
        success: false,
        error: 'you are already logged in',
    });

    const usernameTaken = await UserModel.findOne({ username: { $regex: new RegExp(username, 'i') } });

    if (usernameTaken) return res.status(400).json({
        success: false,
        error: 'the provided username is already taken',
    });

    const emailTaken = await UserModel.findOne({ email: { $regex: new RegExp(email, 'i') } });

    if (emailTaken) return res.status(400).json({
        success: false,
        error: 'an account has already been registered with this email',
    });

    const inviteDoc = await InviteModel.findById(invite);

    if (!inviteDoc || !inviteDoc.useable) return res.status(400).json({
        success: false,
        error: 'invalid invite code',
    });

    if (inviteDoc.redeemed) return res.status(400).json({
        success: false,
        error: 'this invite has already been redeemed',
    });

    let invitedBy = 'Admin';
    const inviter = await UserModel.findOne({ _id: inviteDoc.createdBy.uuid });

    if (inviter) {
        invitedBy = inviter.username;

        await UserModel.findByIdAndUpdate(inviter._id, {
            $push: {
                invitedUsers: username,
            },
        });
    }

    password = await hash(password);

    try {
        const user = await UserModel.create({
            _id: uuid(),
            uid: await getNextUid(),
            username,
            password,
            invite,
            key: `astral_${generateString(30)}`,
            premium: false,
            lastDomainAddition: null,
            lastKeyRegen: null,
            lastUsernameChange: null,
            lastFileArchive: null,
            email,
            emailVerified: false,
            emailVerificationKey: generateString(30),
            discord: {
                id: null,
                avatar: null,
            },
            strikes: 0,
            blacklisted: {
                status: false,
                reason: null,
            },
            uploads: 0,
            invites: 0,
            invitedBy,
            invitedUsers: [],
            registrationDate: new Date(),
            lastLogin: null,
            testimonial: null,
            admin: false,
            notifications: [],
            settings: {
                domain: {
                    name: 'i.astral.cool',
                    subdomain: null,
                },
                randomDomain: {
                    enabled: false,
                    domains: [],
                },
                embed: {
                    enabled: false,
                    color: '#ed13d4',
                    title: 'default',
                    description: 'default',
                    author: 'default',
                    randomColor: false,
                },
                autoWipe: {
                    enabled: false,
                    interval: 3600000,
                },
                showLink: false,
                invisibleUrl: false,
                longUrl: false,
            },
        });

        await user.save();

        await sendVerificationEmail(user);

        await InviteModel.findByIdAndUpdate(invite, {
            usedBy: username,
            redeemed: true,
            useable: false,
        });

        res.status(200).json({
            success: true,
            message: 'registered successfully, check your email to verify',
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

router.post('/login', ValidationMiddleware(LoginSchema), async (req: Request, res: Response) => {
    const { username, password }: {
        username: string;
        password: string;
    } = req.body;

    const user = await UserModel.findOne({ username });

    if (!user || !(user.password.startsWith('$') ? await verify(user.password, password) : false)) return res.status(401).json({
        success: false,
        error: 'invalid username or password',
    });

    if (!user.emailVerified) return res.status(401).json({
        success: false,
        error: 'your email is not verified',
    });

    if (user.blacklisted.status) return res.status(401).json({
        success: false,
        error: `you are blacklisted for: ${user.blacklisted.reason}`,
    });

    try {
        const passwordReset = await PasswordResetModel.findOne({ user: user._id });
        if (passwordReset) await passwordReset.remove();

        await UserModel.findByIdAndUpdate(user._id, {
            lastLogin: new Date(),
        });

        const accessToken = sign({ _id: user._id }, process.env.ACCESS_TOKEN_SECRET, { expiresIn: '15m' });
        const refreshToken = sign({ _id: user._id }, process.env.REFRESH_TOKEN_SECRET);

        await RefreshTokenModel.create({
            token: refreshToken,
            user: user._id,
            expires: new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000),
        });

        res.cookie('x-refresh-token', refreshToken, { httpOnly: true, secure: false });

        res.status(200).json({
            success: true,
            accessToken,
            user: await UserModel.findById(user._id).select('-__v -password'),
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

router.get('/logout', async (req: Request, res: Response) => {
    const cookie = req.cookies['x-refresh-token'];

    if (!cookie) return res.status(401).json({
        success: false,
        error: 'unauthorized',
    });

    try {
        const refreshToken = await RefreshTokenModel.findOne({ token: cookie });

        if (!refreshToken) return res.status(401).json({
            success: false,
            error: 'unauthorized',
        });

        await refreshToken.remove();
        res.clearCookie('x-refresh-token');

        res.status(200).json({
            success: true,
            message: 'logged out successfully',
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

router.get('/verify', ValidationMiddleware(VerifyEmailSchema, 'query'), async (req: Request, res: Response) => {
    const key = req.query.key as string;
    const user = await UserModel.findOne({ emailVerificationKey: key });

    if (!user) return res.status(404).json({
        success: false,
        error: 'invalid verification key',
    });

    if (user.emailVerified) return res.status(400).json({
        success: false,
        error: 'your email is already verified',
    });

    try {
        await UserModel.findByIdAndUpdate(user._id, {
            emailVerified: true,
        });

        res.status(200).json({
            success: true,
            message: 'verified email successfully',
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

router.post('/logout_all_devices', async (req: Request, res: Response) => {

});

export default router;
