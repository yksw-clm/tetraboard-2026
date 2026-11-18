import { expect, test } from "vitest";
import type { StoredProfile } from "@tetraboard/context-account";
import { D1GuestLinks } from "../src/adapters/account/guestLinks";
import { D1GuestLinkWrites } from "../src/adapters/account/guestLinkWrites";
import {
  D1RegistrationWrites,
  prepareRegistrationInsert,
} from "../src/adapters/account/registrationWrites";
import { D1Registrations } from "../src/adapters/account/registrations";
import {
  guestFenceDatabases,
  guestFenceFixture,
  heldGuestLink,
  markDeleted,
  registrationCommand,
} from "./guestFenceFixtures";

const deletedCode = "registration account deleted";

for (const [index, { db, mode }] of guestFenceDatabases.entries()) {
  test(`${mode}でregistration_deleted_account_insertを再現します`, async () => {
    const { target } = await guestFenceFixture(db);
    await markDeleted(db, target.id);
    const command = registrationCommand();
    if (index === 0) {
      await expect(
        db
          .prepare(`INSERT INTO registration_flows
        (id,secret_hash,room_id,instance_id,match_id,old_token_hash,new_token_hash,created_at_ms,hold_until_ms,claim_until_ms,account_id)
        VALUES(?,'secret','12345','instance','match','old','new',1,2,3,?)`)
          .bind(command.registrationId, target.id)
          .run(),
      ).rejects.toThrow(deletedCode);
    }
    await expect(db.batch(prepareRegistrationInsert(db, command, target.id))).rejects.toThrow(
      deletedCode,
    );
    expect(await new D1Registrations(db).read(command.registrationId)).toBeNull();
  });

  test(`${mode}の登録開始でguest_account_idとaccount_idを区別します`, async () => {
    const { guest } = await guestFenceFixture(db);
    await markDeleted(db, guest.id);
    const command = registrationCommand(guest.id);
    const store = new D1RegistrationWrites(db);
    await store.create(command);
    expect(await store.read(command.registrationId)).toMatchObject({
      account_id: null,
      guest_account_id: guest.id,
    });
  });

  test(`${mode}でregistration_deleted_account_updateはOAuthの割り当ても取り消します`, async () => {
    const f = await guestFenceFixture(db);
    const commands = new D1RegistrationWrites(db);
    const command = registrationCommand(f.guest.id);
    const id = command.registrationId;
    await commands.create(command);
    const registration = (await commands.read(id))!;
    await commands.rememberOAuth(registration, f.flow.state, "google", command.now);
    await db
      .prepare(`UPDATE guest_oauth_flows
      SET room_registration_id=?,target_id=NULL,target_session_id=NULL WHERE state=?`)
      .bind(id, f.flow.state)
      .run();
    await markDeleted(db, f.target.id);
    const store = new D1GuestLinks(db);
    const claim = () => store.claim(f.flow, command.now + 600_000, () => command.now);
    if (index === 0) {
      await expect(
        db.batch([
          claim(),
          db.prepare("UPDATE registration_flows SET account_id=? WHERE id=?").bind(f.target.id, id),
        ]),
      ).rejects.toThrow(deletedCode);
    }
    await expect(store.commitClaim(claim(), store.fixRoomRegistration(id, f.flow))).rejects.toThrow(
      deletedCode,
    );
    expect(await commands.read(id)).toEqual(registration);
    expect(
      await db
        .prepare("SELECT target_id,target_session_id FROM guest_oauth_flows WHERE state=?")
        .bind(f.flow.state)
        .first(),
    ).toEqual({ target_id: null, target_session_id: null });
  });

  test(`${mode}で昇格の登録付け替えは退会先を拒否します`, async () => {
    const f = await guestFenceFixture(db, true);
    const { flow, registration } = await heldGuestLink(db, f);
    await markDeleted(db, f.guest.id);
    const store = new D1Registrations(db);
    const before = await store.read(registration.registrationId);

    await expect(
      db.batch(new D1GuestLinkWrites(db).transferRegistration(registration.registrationId, flow)),
    ).rejects.toThrow(deletedCode);

    expect(await store.read(registration.registrationId)).toEqual(before);
  });

  test(`${mode}で旧ゲストのOAuthは退会先を割り当てず状態を消費します`, async () => {
    const f = await guestFenceFixture(db);
    const user = (await db
      .prepare("SELECT * FROM user WHERE id=?")
      .bind(f.target.id)
      .first<StoredProfile>())!;
    const command = registrationCommand();
    const store = new D1RegistrationWrites(db);
    await store.create(command);
    const before = (await store.read(command.registrationId))!;
    await store.rememberOAuth(before, f.flow.state, "google", command.now);
    await markDeleted(db, f.target.id);

    await store.completeOAuth(
      f.flow.state,
      { registration_id: command.registrationId, provider: "google" },
      { user, sessionId: f.flow.target_session_id },
      () => command.now,
    );

    expect(await store.read(command.registrationId)).toEqual(before);
    expect(await store.pendingOAuth(f.flow.state, command.now)).toBeNull();
  });
}
