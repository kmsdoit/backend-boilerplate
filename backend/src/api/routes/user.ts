import {
  createUserSchema,
  listUsersQueryShape,
  paginationQueryShape,
  updateUserSchema,
} from "@app/contracts";
import { route, routes } from "../../lib/app-context.ts";
import { userRepository } from "../../user/user-repository.ts";
import { toUserResponse } from "../../user/user-response.ts";
import { CannotModifySelf, UserEmailTaken, UserNotFound } from "./errors.ts";

export const userRoutes = routes(
  route("/users", "GET", {
    query: { ...paginationQueryShape, ...listUsersQueryShape },
    handler: async ({ query, c }) => {
      const page = await userRepository.list(query);

      // No `total`: counting means reading every matching item. The absence of
      // `nextCursor` is the only "you have reached the end" signal.
      return c.json(
        { items: page.items.map(toUserResponse), nextCursor: page.nextCursor ?? null },
        200,
      );
    },
  }),

  route("/users/:id", "GET", {
    handler: async ({ params, c }) => {
      const user = await userRepository.findById(params.id);

      if (!user) {
        throw UserNotFound();
      }

      return c.json(toUserResponse(user), 200);
    },
  }),

  route("/users", "POST", {
    body: createUserSchema,
    handler: async ({ body, c }) => {
      // The id is generated here, not by the store: DynamoDB has no sequences,
      // and a client-chosen key is what lets the write be a single conditional
      // Put instead of a read-then-write.
      const user = await userRepository.create({ id: crypto.randomUUID(), ...body });

      // null, not an exception: losing the race for an email address is an
      // ordinary outcome, not an error condition.
      if (!user) {
        throw UserEmailTaken();
      }

      return c.json(toUserResponse(user), 201);
    },
  }),

  route("/users/:id", "PATCH", {
    body: updateUserSchema,
    handler: async ({ params, body, c }) => {
      if (c.get("actor").sub === params.id && body.status === "suspended") {
        throw CannotModifySelf();
      }

      const user = await userRepository.update(params.id, body);

      if (!user) {
        throw UserNotFound();
      }

      return c.json(toUserResponse(user), 200);
    },
  }),

  route("/users/:id", "DELETE", {
    handler: async ({ params, c }) => {
      if (c.get("actor").sub === params.id) {
        throw CannotModifySelf();
      }

      const deleted = await userRepository.softDelete(params.id);

      if (!deleted) {
        throw UserNotFound();
      }

      return c.body(null, 204);
    },
  }),
);
