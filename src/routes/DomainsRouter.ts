import { Request, Response, Router } from 'express';
import AdminMiddleware from '../middlewares/AdminMiddleware';
import ValidationMiddleware from '../middlewares/ValidationMiddleware';
import DomainModel from '../models/DomainModel';
import UserModel from '../models/UserModel';
import DomainSchema from '../schemas/DomainSchema';
import CloudflareUtil from '../utils/CloudflareUtil';
import { logDomains } from '../utils/LoggingUtil';
const router = Router();

router.get('/', async (req: Request, res: Response) => {
    try {
        const count = await DomainModel.countDocuments();
        const domains = await DomainModel.find({})
            .select('-__v -_id');

        res.status(200).json({
            success: true,
            count,
            domains,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

router.post('/', AdminMiddleware, ValidationMiddleware(DomainSchema), async (req: Request, res: Response) => {
    if (req.body.length <= 0) return res.status(400).json({
        success: false,
        error: 'provide at least one domain object',
    });

    try {
        for (const field of req.body) {
            const { name, wildcard, donated, donatedBy, userOnly } = field;
            const domain = await DomainModel.findOne({ name });

            if (domain) return res.status(400).json({
                success: false,
                error: `${name} already exists`,
            });

            await CloudflareUtil.addDomain(name, wildcard);

            await DomainModel.create({
                name,
                wildcard,
                donated: donated || false,
                donatedBy: donatedBy || null,
                userOnly: userOnly || false,
                dateAdded: new Date(),
            });
        }

        await logDomains(req.body);

        res.status(200).json({
            success: true,
            message: `${req.body.length > 1 ? `added ${req.body.length} domains` : 'added domain'} successfully`,
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

router.delete('/:name', AdminMiddleware, async (req: Request, res: Response) => {
    const { name } = req.params;
    const domain = await DomainModel.findOne({ name });

    if (!domain) return res.status(404).json({
        success: false,
        error: 'invalid domain',
    });

    try {
        await CloudflareUtil.deleteZone(domain.name);
        await domain.remove();

        res.status(200).json({
            success: true,
            message: 'deleted domain successfully',
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

router.get('/list', async (_req: Request, res: Response) => {
    try {
        const domains = await DomainModel.find({})
            .select('-__v -_id -wildcard -donated -donatedBy -dateAdded');

        res.status(200).json(domains.map((d) => d.name).join(', '));
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

router.get('/rank', async (req: Request, res: Response) => {
    try {
        const domains = await DomainModel.find({});
        const ranks = [];

        for (const domain of domains) {
            const users = await UserModel.countDocuments({ 'settings.domain.name': domain.name });
            ranks.push({
                domain: domain.name,
                users,
            });
        }

        const sorted = ranks.sort((a, b) => a.users - b.users).reverse();

        res.status(200).json(sorted);
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message,
        });
    }
});

export default router;
