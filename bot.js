require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { MongoClient } = require('mongodb');

// Initialize bot
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_IDS = process.env.ADMIN_IDS.split(',').map(id => parseInt(id.trim()));

// MongoDB connection
let db;
let client;

async function connectDB() {
    try {
        client = new MongoClient(process.env.MONGODB_URI);
        await client.connect();
        db = client.db('referralBot');
        console.log('Connected to MongoDB');
        
        // Create indexes if they don't exist
        await db.collection('users').createIndex({ userId: 1 }, { unique: true });
        console.log('Database indexes created');
    } catch (err) {
        console.error('MongoDB connection error:', err);
        process.exit(1);
    }
}

// Connect to database
connectDB().catch(console.error);

// User model functions
async function getUser(userId) {
    if (!db) throw new Error('Database not connected');
    
    const user = await db.collection('users').findOne({ userId });
    if (!user) {
        const newUser = {
            userId,
            balance: 0,
            referrals: [],
            referrer: null,
            withdrawalRequests: []
        };
        await db.collection('users').insertOne(newUser);
        return newUser;
    }
    return user;
}

async function updateUser(userId, update) {
    await db.collection('users').updateOne({ userId }, { $set: update });
}

async function addReferral(referrerId, referralId) {
    const referrer = await getUser(referrerId);
    const referral = await getUser(referralId);
    
    if (!referral.referrer && referrerId !== referralId) {
        // Add referral to referrer
        await db.collection('users').updateOne(
            { userId: referrerId },
            { 
                $push: { referrals: referralId },
                $inc: { balance: 1000 }
            }
        );
        
        // Set referrer for new user and add bonus
        await db.collection('users').updateOne(
            { userId: referralId },
            { 
                $set: { referrer: referrerId },
                $inc: { balance: 500 }
            }
        );
        
        return true;
    }
    return false;
}

// Withdrawal functions
async function createWithdrawalRequest(userId, amount, cardNumber) {
    const user = await getUser(userId);
    if (user.balance >= amount) {
        await db.collection('users').updateOne(
            { userId },
            { 
                $push: { 
                    withdrawalRequests: {
                        amount,
                        cardNumber,
                        status: 'pending',
                        timestamp: new Date()
                    }
                },
                $inc: { balance: -amount }
            }
        );
        return true;
    }
    return false;
}

// Admin functions
async function getAllUsers() {
    return await db.collection('users').find().toArray();
}

async function updateBalance(userId, amount) {
    await db.collection('users').updateOne(
        { userId },
        { $inc: { balance: amount } }
    );
}

// Bot commands and handlers
bot.start(async (ctx) => {
    const userId = ctx.from.id;
    const referrerId = ctx.startPayload ? parseInt(ctx.startPayload) : null;
    
    await getUser(userId);
    
    if (referrerId) {
        const success = await addReferral(referrerId, userId);
        if (success) {
            await ctx.reply(`Tabriklaymiz! Siz referal tizimi orqali qo'shildingiz. Sizga 500 so'm bonus berildi!`);
        }
    }
    
    showMainMenu(ctx);
});

function showMainMenu(ctx) {
    ctx.reply('Asosiy menyu:', Markup.keyboard([
        ['👥 Do\'st taklif qilish', '💰 Balans'],
        ['🆘 Support', '📢 Yangiliklar kanali']
    ]).resize());
}

// Handle menu buttons
bot.hears('👥 Do\'st taklif qilish', async (ctx) => {
    const userId = ctx.from.id;
    const referralLink = `https://t.me/${ctx.botInfo.username}?start=${userId}`;
    
    await ctx.reply(
        `Do'stlaringizni taklif qiling va har bir taklif uchun 1000 so'm oling!\n\n` +
        `Sizning referal havolangiz:\n${referralLink}\n\n` +
        `Har bir do'stingiz ham 500 so'm bonus oladi!\n\n` +
        `Taklif qilgan do'stlaringiz soni: ${(await getUser(userId)).referrals.length} ta`
    );
});

bot.hears('💰 Balans', async (ctx) => {
    const userId = ctx.from.id;
    const user = await getUser(userId);
    
    const keyboard = Markup.inlineKeyboard([
        Markup.button.callback('💸 Pul yechish', 'withdraw')
    ]);
    
    await ctx.reply(
        `💰 Sizning balansingiz: ${user.balance} so'm\n\n` +
        `👥 Taklif qilgan do'stlaringiz soni: ${user.referrals.length} ta`,
        keyboard
    );
});

bot.hears('🆘 Support', (ctx) => {
    ctx.reply('Savollar va takliflaringiz bo\'lsa @hallaym_support ga yozishingiz mumkin.');
});

bot.hears('📢 Yangiliklar kanali', (ctx) => {
    ctx.reply('Bizning yangiliklar kanalimiz: @hallaym');
});

// Withdrawal handler
bot.action('withdraw', async (ctx) => {
    const userId = ctx.from.id;
    const user = await getUser(userId);
    
    if (user.balance < 10000) {
        await ctx.answerCbQuery('Minimal yechish miqdori 10,000 so\'m. Sizda yetarli mablag\' mavjud emas.');
        return;
    }
    
    // Ask for card number first
    await ctx.replyWithMarkdown(
        `💳 Iltimos, pul o'tkazib beriladigan *16 xonali karta raqamingizni* yuboring:\n\n` +
        `*Namuna:* 8600 1234 5678 9012\n\n` +
        `(UzCard yoki Humo)`
    );
    
    // Set up listeners for withdrawal process
    let withdrawalState = { step: 'card', userId };
    
    const onText = async (msgCtx) => {
        if (msgCtx.from.id !== userId) return;
        
        const text = msgCtx.message.text;
        
        if (withdrawalState.step === 'card') {
            // Validate card number
            const cleanedCard = text.replace(/\s+/g, '').replace(/\D/g, '');
            
            if (cleanedCard.length !== 16 || !/^\d+$/.test(cleanedCard)) {
                await msgCtx.replyWithMarkdown(
                    `❌ Noto'g'ri karta raqami formati!\n\n` +
                    `Iltimos, *16 xonali* UzCard yoki Humo raqamingizni kiriting.\n` +
                    `*Namuna:* 8600 1234 5678 9012`
                );
                return;
            }
            
            withdrawalState.cardNumber = cleanedCard.match(/.{1,4}/g).join(' '); // Format: 8600 1234 5678 9012
            withdrawalState.step = 'amount';
            
            await msgCtx.replyWithMarkdown(
                `✅ Karta raqamingiz qabul qilindi: *${withdrawalState.cardNumber}*\n\n` +
                `Endi *yechmoqchi bo'lgan miqdoringizni* kiriting (minimal 10,000 so'm):`
            );
            
        } else if (withdrawalState.step === 'amount') {
            // Validate amount
            const amount = parseInt(text);
            
            if (isNaN(amount)) {
                await msgCtx.reply('Iltimos, faqat raqam kiriting. Masalan: 15000');
                return;
            }
            
            if (amount < 10000) {
                await msgCtx.reply('Minimal yechish miqdori 10,000 so\'m. Iltimos, kattaroq miqdor kiriting.');
                return;
            }
            
            if (amount > user.balance) {
                await msgCtx.reply(`Sizning balansingizda faqat ${user.balance} so'm mavjud. Iltimos, kichikroq miqdor kiriting.`);
                return;
            }
            
            // Create withdrawal request
            const success = await createWithdrawalRequest(
                userId, 
                amount, 
                withdrawalState.cardNumber
            );
            
            if (success) {
                // Notify admins
                for (const adminId of ADMIN_IDS) {
                    const keyboard = Markup.inlineKeyboard([
                        Markup.button.callback('✅ Tasdiqlash', `approve_${userId}_${amount}`),
                        Markup.button.callback('❌ Rad etish', `reject_${userId}_${amount}`)
                    ]);
                    
                    await bot.telegram.sendMessage(
                        adminId,
                        `💰 Yangi pul yechish so'rovi:\n\n` +
                        `👤 Foydalanuvchi: @${msgCtx.from.username || msgCtx.from.first_name}\n` +
                        `🆔 ID: ${userId}\n` +
                        `💳 Karta: ${withdrawalState.cardNumber}\n` +
                        `💵 Miqdor: ${amount} so'm\n` +
                        `📊 Joriy balans: ${user.balance - amount} so'm`,
                        keyboard
                    );
                }
                
                await msgCtx.replyWithMarkdown(
                    `📨 Sizning pul yechish so'rovingiz adminlarga yuborildi:\n\n` +
                    `*💳 Karta raqam:* ${withdrawalState.cardNumber}\n` +
                    `*💵 Miqdor:* ${amount} so'm\n\n` +
                    `⏳ So'rovingiz tez orada ko'rib chiqiladi.`
                );
            } else {
                await msgCtx.reply('Xatolik yuz berdi. Iltimos, keyinroq urunib ko\'ring.');
            }
            
            // Clean up
            bot.off('text', onText);
        }
    };
    
    bot.on('text', onText);
    
    // Set timeout to remove listener if user doesn't respond
    setTimeout(() => {
        bot.off('text', onText);
    }, 60000); // 1 minute timeout
});

// Admin commands
bot.command('admin', async (ctx) => {
    const userId = ctx.from.id;
    
    if (ADMIN_IDS.includes(userId)) {
        const keyboard = Markup.inlineKeyboard([
            Markup.button.callback('Foydalanuvchilar ro\'yxati', 'user_list'),
            Markup.button.callback('Admin panel', 'admin_panel')
        ]);
        
        await ctx.reply('Admin panel:', keyboard);
    }
});

// Admin actions
bot.action('user_list', async (ctx) => {
    if (ADMIN_IDS.includes(ctx.from.id)) {
        const users = await getAllUsers();
        let message = 'Foydalanuvchilar ro\'yxati:\n\n';
        
        for (const user of users) {
            message += `🆔 ID: ${user.userId}\n` +
                      `💰 Balans: ${user.balance} so'm\n` +
                      `👥 Referrallar: ${user.referrals.length} ta\n` +
                      `💳 So'nggi karta: ${user.withdrawalRequests.length > 0 ? 
                         user.withdrawalRequests[user.withdrawalRequests.length-1].cardNumber : 
                         'Noma\'lum'}\n\n`;
        }
        
        await ctx.reply(message);
    }
});

bot.action(/^approve_(\d+)_(\d+)$/, async (ctx) => {
    if (ADMIN_IDS.includes(ctx.from.id)) {
        const userId = parseInt(ctx.match[1]);
        const amount = parseInt(ctx.match[2]);
        
        // Update withdrawal status
        await db.collection('users').updateOne(
            { 
                userId,
                'withdrawalRequests.amount': amount,
                'withdrawalRequests.status': 'pending'
            },
            { 
                $set: { 'withdrawalRequests.$.status': 'approved' } 
            }
        );
        
        await ctx.answerCbQuery(`Pul yechish tasdiqlandi: ${amount} so'm`);
        await ctx.editMessageText(
            `✅ ${ctx.update.callback_query.message.text}\n\n` +
            `Admin: @${ctx.from.username}\n` +
            `Holat: Tasdiqlandi\n` +
            `Sana: ${new Date().toLocaleString()}`
        );
        
        // Notify user
        await bot.telegram.sendMessage(
            userId,
            `🎉 Sizning ${amount} so'm miqdordagi pul yechish so'rovingiz tasdiqlandi!\n\n` +
            `💸 Mablag' 1-3 ish kunida kartangizga o'tkaziladi.`
        );
    }
});

bot.action(/^reject_(\d+)_(\d+)$/, async (ctx) => {
    if (ADMIN_IDS.includes(ctx.from.id)) {
        const userId = parseInt(ctx.match[1]);
        const amount = parseInt(ctx.match[2]);
        
        // Update withdrawal status and return money
        await db.collection('users').updateOne(
            { 
                userId,
                'withdrawalRequests.amount': amount,
                'withdrawalRequests.status': 'pending'
            },
            { 
                $set: { 'withdrawalRequests.$.status': 'rejected' },
                $inc: { balance: amount }
            }
        );
        
        await ctx.answerCbQuery(`Pul yechish rad etildi. Mablag' foydalanuvchi balansiga qaytarildi.`);
        await ctx.editMessageText(
            `❌ ${ctx.update.callback_query.message.text}\n\n` +
            `Admin: @${ctx.from.username}\n` +
            `Holat: Rad etildi\n` +
            `Sana: ${new Date().toLocaleString()}`
        );
        
        // Notify user
        await bot.telegram.sendMessage(
            userId,
            `❌ Sizning ${amount} so'm miqdordagi pul yechish so'rovingiz rad etildi.\n\n` +
            `💰 Mablag' balansingizga qaytarildi. Yangi balans: ${(await getUser(userId)).balance} so'm`
        );
    }
});

bot.action('admin_panel', async (ctx) => {
    if (ADMIN_IDS.includes(ctx.from.id)) {
        await ctx.reply(
            `Admin panel buyruqlari:\n\n` +
            `/setbalance [user_id] [amount] - Balansni o'zgartirish\n` +
            `/userinfo [user_id] - Foydalanuvchi ma'lumotlari\n\n` +
            `Misol:\n` +
            `/setbalance 123456789 5000`
        );
    }
});

// Admin command to set balance
bot.command('setbalance', async (ctx) => {
    if (ADMIN_IDS.includes(ctx.from.id)) {
        const args = ctx.message.text.split(' ');
        if (args.length !== 3) {
            await ctx.reply('Noto\'g\'ri format. Iltimos, /setbalance [user_id] [amount] formatida yuboring.');
            return;
        }
        
        const userId = parseInt(args[1]);
        const amount = parseInt(args[2]);
        
        if (isNaN(userId) || isNaN(amount)) {
            await ctx.reply('User ID va miqdor raqam bo\'lishi kerak.');
            return;
        }
        
        await updateBalance(userId, amount);
        await ctx.reply(`Foydalanuvchi ${userId} balansi ${amount} so'mga o\'zgartirildi.`);
        
        // Notify user
        await bot.telegram.sendMessage(
            userId,
            `🔔 Admin tomonidan balansingiz ${amount > 0 ? '+' : ''}${amount} so'mga o\'zgartirildi.\n\n` +
            `💰 Yangi balans: ${(await getUser(userId)).balance} so'm`
        );
    }
});

// Start the bot
bot.launch().then(() => {
    console.log('Bot started successfully');
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));