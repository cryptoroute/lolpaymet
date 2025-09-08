const express = require("express")
const mysql = require("mysql2/promise")
const fetch = require("node-fetch")
const cors = require("cors")

class WebhookServer {
  constructor() {
    this.app = express()
    this.port = process.env.PORT || 3000
    this.setupMiddleware()
    this.setupRoutes()
    this.setupDatabase()
  }

  setupMiddleware() {
    this.app.use(cors())
    this.app.use(express.json())
    this.app.use(express.urlencoded({ extended: true }))

    // Request logging
    this.app.use((req, res, next) => {
      console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`)
      next()
    })
  }

  setupDatabase() {
    this.dbConfig = {
      host: process.env.DB_HOST || "db1.sillydevelopment.co.uk",
      user: process.env.DB_USER || "u2714_FC3lB17rIh",
      password: process.env.DB_PASSWORD || "sz!gocc3g@QfcNe^iQC7@ndV",
      database: process.env.DB_NAME || "s2714_Snorrel",
      port: process.env.DB_PORT || 3306,
      connectionLimit: 10,
      acquireTimeout: 60000,
      timeout: 60000,
    }

    this.pool = mysql.createPool(this.dbConfig)
    console.log("Database connection pool created")
  }

  setupRoutes() {
    // Health check endpoint
    this.app.get("/health", (req, res) => {
      res.json({
        status: "ok",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      })
    })

    // Main webhook endpoint for CryptAPI callbacks
    this.app.all("/webhook", async (req, res) => {
      try {
        console.log("Webhook received:", req.query, req.body)

        const orderId = req.query.order_id || req.body.order_id
        const status = req.query.status || req.body.status || "pending_confirmation"
        const txid = req.query.txid_in || req.body.txid_in
        const value = req.query.value || req.body.value
        const confirmations = req.query.confirmations || req.body.confirmations || 0

        if (!orderId) {
          return res.status(400).json({ error: "Missing order_id" })
        }

        const result = await this.handlePaymentCallback(orderId, status, txid, value, confirmations)

        if (result.success) {
          res.json({ status: "ok", message: "Payment processed successfully" })
        } else {
          res.status(400).json({ error: result.error })
        }
      } catch (error) {
        console.error("Webhook error:", error)
        res.status(500).json({ error: "Internal server error" })
      }
    })

    // Payment status check endpoint
    this.app.get("/payment/:orderId", async (req, res) => {
      try {
        const { orderId } = req.params
        const payment = await this.getPaymentStatus(orderId)

        if (payment) {
          res.json(payment)
        } else {
          res.status(404).json({ error: "Payment not found" })
        }
      } catch (error) {
        console.error("Payment status error:", error)
        res.status(500).json({ error: "Internal server error" })
      }
    })

    // Test endpoint for development
    this.app.post("/test-webhook", async (req, res) => {
      try {
        const { orderId, status = "confirmed", txid = "test_tx_123" } = req.body

        if (!orderId) {
          return res.status(400).json({ error: "Missing orderId" })
        }

        const result = await this.handlePaymentCallback(orderId, status, txid, "100", 1)
        res.json(result)
      } catch (error) {
        console.error("Test webhook error:", error)
        res.status(500).json({ error: "Internal server error" })
      }
    })
  }

  async handlePaymentCallback(orderId, status, txid, value, confirmations) {
    try {
      console.log(`Processing payment callback: ${orderId}, status: ${status}`)

      // Get payment details from database
      const [payments] = await this.pool.execute("SELECT * FROM payments WHERE order_id = ?", [orderId])

      if (payments.length === 0) {
        console.error(`Payment not found for order: ${orderId}`)
        return { success: false, error: "Payment not found" }
      }

      const payment = payments[0]

      if (status === "confirmed" && confirmations >= 1) {
        // Payment confirmed - activate user plan
        const isUpgrade = payment.is_upgrade === 1

        if (isUpgrade) {
          // For upgrades, only update the plan name to Advanced
          await this.pool.execute("UPDATE users SET plan_name = ? WHERE telegram_id = ?", [
            "Advanced",
            payment.telegram_id,
          ])
          console.log(`User ${payment.telegram_id} plan upgraded to Advanced`)
        } else {
          // Regular payment - update both plan and expiry
          await this.updateUserPlan(payment.telegram_id, payment.plan_name, payment.duration)
          console.log(`User ${payment.telegram_id} plan activated: ${payment.plan_name} for ${payment.duration}`)
        }

        // Update payment status
        await this.pool.execute("UPDATE payments SET status = ?, txid = ?, confirmed_at = NOW() WHERE order_id = ?", [
          "completed",
          txid,
          orderId,
        ])

        // Send notification to bot
        await this.notifyBot(payment, txid, isUpgrade)

        return { success: true, message: "Payment confirmed and user activated" }
      } else if (status === "pending_confirmation") {
        // Update payment status to pending
        await this.pool.execute("UPDATE payments SET status = ?, txid = ? WHERE order_id = ?", [
          "pending",
          txid,
          orderId,
        ])

        // Send pending notification to bot
        await this.notifyBotPending(payment, txid)

        return { success: true, message: "Payment pending confirmation" }
      }

      return { success: false, error: "Invalid payment status" }
    } catch (error) {
      console.error("Payment callback error:", error)
      return { success: false, error: error.message }
    }
  }

  async updateUserPlan(telegramId, planName, duration) {
    try {
      const expiry = this.calculateExpiry(duration)

      await this.pool.execute("UPDATE users SET plan_name = ?, expiry = ? WHERE telegram_id = ?", [
        planName,
        expiry,
        telegramId,
      ])

      console.log(`Updated user ${telegramId} plan to ${planName} until ${expiry}`)
    } catch (error) {
      console.error("Error updating user plan:", error)
      throw error
    }
  }

  calculateExpiry(duration) {
    const now = new Date()
    switch (duration) {
      case "1 week":
        return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000)
      case "1 month":
        return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
      case "3 months":
        return new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000)
      case "12 months":
        return new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000)
      default:
        return new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000)
    }
  }

  async getPaymentStatus(orderId) {
    try {
      const [payments] = await this.pool.execute("SELECT * FROM payments WHERE order_id = ?", [orderId])

      return payments[0] || null
    } catch (error) {
      console.error("Error getting payment status:", error)
      throw error
    }
  }

  async notifyBot(payment, txid, isUpgrade = false) {
    try {
      const botToken = process.env.BOT_TOKEN
      if (!botToken) {
        console.warn("BOT_TOKEN not set, skipping bot notification")
        return
      }

      let message
      if (isUpgrade) {
        message =
          `✅ *Plan Upgraded Successfully!*\n\n` +
          `🎉 Your plan has been upgraded to Advanced!\n\n` +
          `*Upgrade Details:*\n` +
          `• New Plan: Advanced\n` +
          `• Duration: ${payment.duration}\n` +
          `• Transaction ID: \`${txid}\`\n\n` +
          `🚀 You now have access to:\n` +
          `• Faster forwarding (1-3 min intervals)\n` +
          `• More groups per interval (4 vs 2)\n` +
          `• Priority support\n\n` +
          `*Support:* @Snorrel`
      } else {
        const expiryDate = this.calculateExpiry(payment.duration)
        message =
          `✅ *Payment Confirmed!*\n\n` +
          `🎉 Your ${payment.plan_name} plan has been activated!\n\n` +
          `*Plan Details:*\n` +
          `• Plan: ${payment.plan_name}\n` +
          `• Duration: ${payment.duration}\n` +
          `• Expires: ${expiryDate.toLocaleDateString()}\n` +
          `• Transaction ID: \`${txid}\`\n\n` +
          `🚀 Your account is now active and ready to use!\n\n` +
          `*Support:* @Snorrel`
      }

      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: payment.telegram_id,
          text: message,
          parse_mode: "Markdown",
        }),
      })

      if (response.ok) {
        console.log(`Notification sent to user ${payment.telegram_id}`)
      } else {
        console.error("Failed to send bot notification:", await response.text())
      }
    } catch (error) {
      console.error("Error sending bot notification:", error)
    }
  }

  async notifyBotPending(payment, txid) {
    try {
      const botToken = process.env.BOT_TOKEN
      if (!botToken) {
        console.warn("BOT_TOKEN not set, skipping bot notification")
        return
      }

      const message =
        `*Payment Received - Pending Confirmation*\n\n` +
        `We've received your payment and it's being confirmed on the blockchain.\n\n` +
        `*Details:*\n` +
        `• Amount: ${payment.crypto_amount} ${payment.crypto_type.toUpperCase()}\n` +
        `• Plan: ${payment.plan_name} (${payment.duration})\n` +
        `• Transaction ID: \`${txid}\`\n\n` +
        `Your plan will be activated automatically once confirmed!\n\n` +
        `*Support:* @Snorrel`

      const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: payment.telegram_id,
          text: message,
          parse_mode: "Markdown",
        }),
      })

      if (response.ok) {
        console.log(`Pending notification sent to user ${payment.telegram_id}`)
      } else {
        console.error("Failed to send pending notification:", await response.text())
      }
    } catch (error) {
      console.error("Error sending pending notification:", error)
    }
  }

  start() {
    this.app.listen(this.port, () => {
      console.log(`🚀 Webhook server running on port ${this.port}`)
      console.log(`📡 Webhook endpoint: http://localhost:${this.port}/webhook`)
      console.log(`🏥 Health check: http://localhost:${this.port}/health`)
    })

    // Graceful shutdown
    process.on("SIGTERM", () => {
      console.log("SIGTERM received, shutting down gracefully")
      this.pool.end()
      process.exit(0)
    })

    process.on("SIGINT", () => {
      console.log("SIGINT received, shutting down gracefully")
      this.pool.end()
      process.exit(0)
    })
  }
}

// Start server if this file is run directly
if (require.main === module) {
  const server = new WebhookServer()
  server.start()
}

module.exports = WebhookServer
