// src/pages/api/assignments.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const data = await prisma.assignment.findMany({
    orderBy: [{ team: 'asc' }, { caddyName: 'asc' }],
  });
  res.status(200).json(data);
}
