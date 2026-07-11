import { PrismaService } from '@app/infra/prisma/prisma.service';
import { SessionService } from './session.service';

interface Row {
  id: string;
  userId: string;
  revokedAt: Date | null;
  expiresAt: Date;
}

function makeDb() {
  const rows = new Map<string, Row>();
  let seq = 0;
  const calls = { findUnique: 0, update: 0 };
  const db = {
    session: {
      create: jest.fn(({ data }: { data: { userId: string; expiresAt: Date } }) => {
        const id = `sess-${++seq}`;
        rows.set(id, { id, userId: data.userId, revokedAt: null, expiresAt: data.expiresAt });
        return Promise.resolve({ id });
      }),
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        calls.findUnique++;
        const r = rows.get(where.id);
        return Promise.resolve(r ? { revokedAt: r.revokedAt, expiresAt: r.expiresAt } : null);
      }),
      update: jest.fn(({ where }: { where: { id: string } }) => {
        calls.update++;
        return Promise.resolve(rows.get(where.id) ?? null);
      }),
      findMany: jest.fn(({ where }: { where: { userId: string; id?: { not: string } } }) => {
        const out = [...rows.values()].filter(
          (r) =>
            r.userId === where.userId &&
            r.revokedAt === null &&
            (where.id?.not === undefined || r.id !== where.id.not),
        );
        return Promise.resolve(out.map((r) => ({ id: r.id })));
      }),
      updateMany: jest.fn(
        ({ where, data }: { where: { userId: string; id?: { not: string } }; data: { revokedAt: Date } }) => {
          let count = 0;
          for (const r of rows.values()) {
            if (
              r.userId === where.userId &&
              r.revokedAt === null &&
              (where.id?.not === undefined || r.id !== where.id.not)
            ) {
              r.revokedAt = data.revokedAt;
              count++;
            }
          }
          return Promise.resolve({ count });
        },
      ),
    },
  };
  return { db, rows, calls };
}

function make() {
  const { db, rows, calls } = makeDb();
  const svc = new SessionService(db as unknown as PrismaService);
  return { svc, rows, calls, db };
}

describe('SessionService', () => {
  let nowSpy: jest.SpyInstance;
  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => nowSpy.mockRestore());

  it('create caches active — subsequent isActive within TTL does not hit the DB', async () => {
    const { svc, calls } = make();
    const id = await svc.create('u1', '1.2.3.4', 'agent');
    expect(await svc.isActive(id)).toBe(true);
    expect(await svc.isActive(id)).toBe(true);
    expect(calls.findUnique).toBe(0); // served from cache
  });

  it('re-queries the DB after the 30s cache TTL', async () => {
    const { svc, calls } = make();
    const id = await svc.create('u1', 'ip', null);
    await svc.isActive(id); // cached
    expect(calls.findUnique).toBe(0);
    now += 31_000; // past TTL
    await svc.isActive(id);
    expect(calls.findUnique).toBe(1);
  });

  it('revoke flips the cache synchronously — isActive is false immediately', async () => {
    const { svc, calls } = make();
    const id = await svc.create('u1', 'ip', null);
    expect(await svc.revoke('u1', id)).toBe(true);
    expect(await svc.isActive(id)).toBe(false);
    expect(calls.findUnique).toBe(0); // negative result came from cache
  });

  it('revoke by a non-owner does nothing', async () => {
    const { svc, rows } = make();
    const id = await svc.create('u1', 'ip', null);
    expect(await svc.revoke('other', id)).toBe(false);
    expect(rows.get(id)!.revokedAt).toBeNull();
  });

  it('treats an expired session as inactive', async () => {
    const { svc } = make();
    const id = await svc.create('u1', 'ip', null);
    now += 8 * 24 * 60 * 60 * 1000; // past the 7d TTL baked into expiresAt
    // force a DB re-read by also aging past the cache TTL
    expect(await svc.isActive(id)).toBe(false);
  });

  it('revokeAllExcept keeps the current session and revokes the rest', async () => {
    const { svc } = make();
    const a = await svc.create('u1', 'ip', null);
    const b = await svc.create('u1', 'ip', null);
    const c = await svc.create('u1', 'ip', null);
    await svc.revokeAllExcept('u1', b);
    expect(await svc.isActive(a)).toBe(false);
    expect(await svc.isActive(b)).toBe(true);
    expect(await svc.isActive(c)).toBe(false);
  });

  it('list returns active sessions and flags the current one', async () => {
    const { svc } = make();
    const a = await svc.create('u1', 'ip', 'A');
    const b = await svc.create('u1', 'ip', 'B');
    const list = await svc.list('u1', b);
    expect(list.map((s) => s.id).sort()).toEqual([a, b].sort());
    expect(list.find((s) => s.id === b)!.current).toBe(true);
    expect(list.find((s) => s.id === a)!.current).toBe(false);
  });

  it('unknown session id is inactive', async () => {
    const { svc } = make();
    expect(await svc.isActive('nope')).toBe(false);
  });
});
