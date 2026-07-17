/** @format */
import {
    gradeTaglineIsProductFirst,
    gradePitchOpensWithProduct,
    gradeNoInfraOpener,
    gradeProductFraming,
    type ProductGradeInput,
} from './case-study-product-grader.js';

// The product truth the loader would feed as <productContext>.
const PRODUCT_CONTEXT =
    'Tucaken is a SaaS that lets job-seekers connect their GitHub account to generate ' +
    'JD-tailored resumes from their verified skills. It solves the problem of resumes ' +
    'claiming skills the candidate cannot prove and the manual effort of tailoring to each job.';

// The current (bad) output: leads with infrastructure, never says what it does.
const BAD: ProductGradeInput = {
    productContext: PRODUCT_CONTEXT,
    tagline: 'Production SaaS platform across four repositories with Kubernetes, AWS CDK, and Bedrock',
    pitch:
        'I built a production SaaS platform spanning four repositories — an AI applications ' +
        'backend, a full AWS CDK infrastructure layer, a Kubernetes bootstrap repo, and a React ' +
        'frontend — running 14 microservices as Kubernetes Jobs orchestrated by ArgoCD.\n\n' +
        'The infrastructure layer is a 16-CDK-stack monorepo with Karpenter autoscaling.',
};

// A good output: leads with the product + problem, then the engineering.
const GOOD: ProductGradeInput = {
    productContext: PRODUCT_CONTEXT,
    tagline: 'Tucaken — connect your GitHub to generate job-tailored resumes from skills you can prove',
    pitch:
        'I built Tucaken, a SaaS that lets job-seekers connect their GitHub account and generate ' +
        'resumes tailored to a specific job, grounded in skills verified from their actual code — ' +
        'solving the problem of resumes that claim abilities the candidate cannot prove.\n\n' +
        'Under the hood it ingests repositories, extracts verified skill evidence, and synthesises ' +
        'tailored resumes through a multi-agent Bedrock pipeline running on EKS.',
};

describe('gradeTaglineIsProductFirst', () => {
    it('fails a tech-dominated tagline', () => {
        const r = gradeTaglineIsProductFirst(BAD);
        expect(r.pass).toBe(false);
        expect(r.failures.some((f) => /tech-dominated/.test(f))).toBe(true);
    });
    it('passes a product-named tagline', () => {
        expect(gradeTaglineIsProductFirst(GOOD).pass).toBe(true);
    });
});

describe('gradePitchOpensWithProduct', () => {
    it('fails when the first paragraph does not echo the product context', () => {
        expect(gradePitchOpensWithProduct(BAD).pass).toBe(false);
    });
    it('passes when the first paragraph carries the product purpose', () => {
        expect(gradePitchOpensWithProduct(GOOD).pass).toBe(true);
    });
    it('is a no-op pass when no productContext exists', () => {
        expect(gradePitchOpensWithProduct({ ...BAD, productContext: null }).pass).toBe(true);
    });
});

describe('gradeNoInfraOpener', () => {
    it('flags the "platform spanning N repositories" opener', () => {
        const r = gradeNoInfraOpener(BAD);
        expect(r.pass).toBe(false);
        expect(r.score).toBe(0.5);
    });
    it('accepts a product-led opener', () => {
        expect(gradeNoInfraOpener(GOOD).pass).toBe(true);
    });
});

describe('gradeProductFraming', () => {
    it('the bad output fails overall, the good output passes', () => {
        expect(gradeProductFraming(BAD).pass).toBe(false);
        expect(gradeProductFraming(GOOD).pass).toBe(true);
    });
});
