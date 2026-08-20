import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Fiber, PubSub, Queue, Stream } from "effect"
import type { NotificationStreamEvent } from "@yaade/shared"
import { EventHub } from "./events.js"

test("notification PubSub bridge fans out to EventHub notifications:event", async () => {
  const events = new EventHub(64)
  const seen: NotificationStreamEvent[] = []
  const unsub = events.subscribe(event => {
    if (event.channel === "notifications:event") {
      seen.push(event.args[0] as NotificationStreamEvent)
    }
  })

  await Effect.runPromise(
    Effect.gen(function* () {
      const pubsub = yield* PubSub.unbounded<NotificationStreamEvent>()
      const collected = yield* Stream.fromPubSub(pubsub).pipe(
        Stream.take(1),
        Stream.runCollect,
        Effect.fork,
      )
      // Ensure the stream subscription is live before publishing.
      yield* Effect.yieldNow()
      yield* PubSub.publish(pubsub, {
        type: "notification.counts-updated",
        counts: {
          totalUnread: 3,
          actionRequired: 0,
          errors: 0,
        },
      })
      const chunk = yield* Fiber.join(collected)
      const event = [...chunk][0]!
      events.emit("notifications:event", [event])
      yield* PubSub.shutdown(pubsub)
    }),
  )

  unsub()
  assert.equal(seen.length, 1)
  assert.equal(seen[0]?.type, "notification.counts-updated")
  if (seen[0]?.type === "notification.counts-updated") {
    assert.equal(seen[0].counts.totalUnread, 3)
  }
})

test("PubSub.subscribe delivers notification stream events", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const pubsub = yield* PubSub.unbounded<NotificationStreamEvent>()
        const queue = yield* PubSub.subscribe(pubsub)
        yield* PubSub.publish(pubsub, {
          type: "notification.dismissed",
          notificationId: "n-1",
        })
        const event = yield* Queue.take(queue)
        assert.equal(event.type, "notification.dismissed")
        if (event.type === "notification.dismissed") {
          assert.equal(event.notificationId, "n-1")
        }
      }),
    ),
  )
})
