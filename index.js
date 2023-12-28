import axios from 'axios';
import cors from 'cors';
import chalk from 'chalk';
import async from 'async';
import dotenv from 'dotenv';
import express from 'express';
import { ObjectId } from 'mongodb';
import { getIPAddress } from "./WB_module/network/utility/ip.js";
import { checkProxy } from './WB_module/network/controller/networkController.js';
import { getCurrentDateInMoscow } from "./WB_module/queue/utility/time.js";
import { sendErrorToTelegram } from './WB_module/telegram/telegramErrorNotifier.js';
import { likeProductHandler } from './src/liker/liker_product/controller/productController.js';
import { likeBrandHandler } from './src/liker/liker_brand/controller/brandController.js';
import { 
    getProxyWithRetries, 
    getRandomPhoneNumberWithRetries 
} from './WB_module/queue/utility/resourses.js';
import {
    checkNewLikes,
    processWorkRecords,
    rescheduleIncompleteTasks,
    updateNoFundsRecordsWithBalances
} from './src/liker/controller_productlikes/productlikesDbController.js';
import {
    databaseConnectRequest,
    getDb,
    database2ConnectRequest,
    getDb2,
    database3ConnectRequest,
    getDb3,
} from './WB_module/database/config/database.js';

// Подключение env файла
dotenv.config();

// Настройка сервера express + использование cors и json
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4001;

const MINIMUM_INTERVAL_PRODUCTLIKES = 120000;

// Стоимость лайка на продукт/бренд
const PRICE_PER_BRANDPRODUCT_LIKE = 5;

// Настройка максимально допустиых значений параллельного запуска функций
const MAX_TOTAL_ACTIVE_TASKS = 5;
const MAX_PARALLEL_PRODUCTLIKES = 5;

// Настройка максимально допустимых значений повторного добавления в очередь
const RETRY_LIMIT = 3;
const READD_RETRY_LIMIT = 10;

// Настройка максимально допустимых значений повторного получения прокси
const PROXY_RETRY_LIMIT = 10;

// Настройка параметра возможности добавления новых задач в очередь
let acceptingTasks = true;

// Текущие активные задачи
let totalActiveTasks = 0;
let likesCount = {
    productlikes: 0
};

// Интервалы проверки базы данных
const INTERVAL_NEW_LIKES = 20000;
const INTERVAL_WORK_LIKES = 25000;
const INTERVAL_INCOMPLITE_LIKES = 30000;
const INTERVAL_NOFUNDS_LIKES = 35000;

// Метод получения базового ответа от API productliker
app.get('/api/', (req, res) => {
    res.status(200).json('Привет от API productliker!');
});

// Метод остановки принятия задач в очередь API productliker
app.post('/api/stopQueue', async (req, res) => {
    acceptingTasks = false;
    res.status(200).json({ message: 'Остановили принятие задач на обработку в очередь' });
});

// Метод запуска принятия задач в очередь API productliker
app.post('/api/startQueue', async (req, res) => {
    acceptingTasks = true;
    res.status(200).json({ message: 'Возобновили принятие задач на обработку в очередь' });
});

// Метод запуска принятия задач в очередь API cartsliker
app.post('/api/resetQueueCount', async (req, res) => {
    totalActiveTasks = 0;
    likesCount['productlikes'] = 0;
    res.status(200).json({ message: 'Сбросили очередь.' });
});

// Метод получения статуса очереди API productliker
app.get('/api/queueStatus', async (req, res) => {
    try {
        const queueInfo = await getQueueInfo(likeQueue, acceptingTasks, totalActiveTasks, likesCount);
        res.status(200).json({
            message: 'Текущее состояние очереди',
            queueInfo: queueInfo
        });
    } catch (error) {
        console.error('Ошибка получения статуса очереди:', error);
        res.status(500).json({ error: 'Ошибка получения статуса очереди' });
    }
});

const startServer = async () => {
    try {
        console.log('Попытка подключения к базе данных...');
        const isConnected = await databaseConnectRequest();
        if (!isConnected) {
            throw new Error('Подключение к базе данных topvtop_backend не может быть установлено');
        }

        const isConnected2 = await database2ConnectRequest();
        if (!isConnected2) {
            throw new Error('Подключение к базе данных payments не может быть установлено');
        }

        const isConnected3 = await database3ConnectRequest();
        if (!isConnected3) {
            throw new Error('Подключение к базе данных topvtop_bd не может быть установлено');
        }

        console.log(chalk.grey('Запускаем сервер...'));
        app.listen(PORT, async () => {
            console.log(chalk.green(`Сервер запущен на порту ${PORT}`));

            // setInterval(async () => {
            //     try {
            //         await processLikeQueue();
            //     } catch (error) {
            //         console.error('Ошибка при проверке новых лайков:', error);
            //         await sendErrorToTelegram(`Ошибка при проверке очереди лайков: ${error.message}`, 'processLikeQueue');
            //     }
            // }, INTERVAL_NEW_LIKES);

            setInterval(async () => {
                try {
                    if (acceptingTasks) {
                        await checkNewLikes();
                    }
                } catch (error) {
                    console.error('Ошибка при проверке новых лайков:', error);
                    await sendErrorToTelegram(`Ошибка при проверке новых лайков: ${error.message}`, 'checkNewLikes');
                }
            }, INTERVAL_NEW_LIKES);

            setInterval(async () => {
                try {
                    if (acceptingTasks) {
                        let eligibleRecords = await processWorkRecords(totalActiveTasks, acceptingTasks);
                        console.log('Записи готовые к обработке в статусе "work":', eligibleRecords);
                        await addEligibleRecordsToQueue(eligibleRecords);
                    }
                } catch (error) {
                    console.error('Ошибка при проверке записей в статусе "work":', error);
                    await sendErrorToTelegram(`Ошибка при проверке записей в статусе "work": ${error.message}`, 'processWorkRecords');
                }
            }, INTERVAL_WORK_LIKES);

            setInterval(async () => {
                try {
                    if (acceptingTasks) {
                        await rescheduleIncompleteTasks();
                    }
                } catch (error) {
                    console.error('Ошибка при проверке неполных записей:', error);
                    await sendErrorToTelegram(`Ошибка при проверке неполных записей: ${error.message}`, 'rescheduleIncompleteTasks');
                }
            }, INTERVAL_INCOMPLITE_LIKES);

            setInterval(async () => {
                try {
                    if (acceptingTasks) {
                        await updateNoFundsRecordsWithBalances();
                    }
                } catch (error) {
                    console.error('Ошибка при проверке записей без баланса:', error);
                    await sendErrorToTelegram(`Ошибка при проверке записей без баланса: ${error.message}`, 'updateNoFundsRecordsWithBalances');
                }
            }, INTERVAL_NOFUNDS_LIKES);
        });


    } catch (error) {
        console.error(chalk.red('Ошибка при запуске сервера:', error));
        await sendErrorToTelegram(`Ошибка при запуске сервера: ${error.message}`, 'startServer');
    }
};

startServer().then(server => {
    if (server) {
        server.on('error', (error) => {
            if (error.code === 'EADDRINUSE') {
                console.error(chalk.red(`Порт ${PORT} занят!`));
            } else {
                console.error(chalk.red('Произошла ошибка при запуске сервера:'), error);
            }
        });
    }
});

// Логика воркера очереди задач
const likeQueue = async.queue(async (task) => {
    try {
        switch (task.likeRecord.type) {
            case 'brand':
            case 'product':
                console.log('Обработка очереди productlikes');
                await processBrandAndProductLike(task);
                break;
            case 'likes':
            case 'carts':
                throw new Error(`Данный сервер предназначен для обработки задач из коллекции productlikes, получили: ${task.likeRecord.type}`);
            default:
                throw new Error(`Неизвестный тип лайка: ${task.likeRecord.type}`);
        }
    } catch (error) {
        console.error(`Ошибка при обработке likeId ${task.likeRecord._id.toString()}:`, error);
        await sendErrorToTelegram(`Ошибка при обработке likeId ${task.likeRecord._id.toString()}: ${error.message}`, 'processLikeQueue');

        if (error.message === 'NO_AVAILABLE_PROXY' || error.message === 'NO_AVAILABLE_ACCOUNT') {
            await reAddToLikeQueueWithTimeout(task.likeRecord, task.retries);
        } else {
            throw error;
        }
    }
}, MAX_TOTAL_ACTIVE_TASKS);

likeQueue.error((err, task) => {
    console.error('Ошибка при обработке задачи:', err, 'Задача:', task);
});

// Функция добавления задач в очередь
const addEligibleRecordsToQueue = async (eligibleRecords) => {
    for (const record of eligibleRecords) {
        if (totalActiveTasks < MAX_TOTAL_ACTIVE_TASKS) {
            const db3 = getDb3();
            const result = await db3.collection('productlikes').updateOne(
                { _id: record._id }, 
                { $pull: { schedule: new Date(record.schedule[0]) } }
            );

            // Check if the operation modified any document
            if (result.modifiedCount === 1) {
                console.log(`Успешно убрали дату из расписания ${record._id}`);
                likeQueue.push({ likeRecord: record, retries: 0 });
                totalActiveTasks++;
                likesCount['productlikes']++;
            } else {
                console.error(`Не удалось убрать дату из расписания ${record._id}`);
            }
        }
    }
};

// Функция задержки
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Функция получения информации об очереди
const getQueueInfo = async () => {
    return {
        length: likeQueue.length(),
        isProcessing: !likeQueue.idle(),
        acceptingTasks: acceptingTasks,
        totalActiveTasks: totalActiveTasks,
        typesCount: likesCount,
    };
};

// Функция отслеживания очереди задач
const processLikeQueue = async () => {
    console.log("Начало обработки очереди лайков");
    console.log("Очередь: ", likeQueue.length());

    if (likeQueue.idle()) {
        console.log("Очередь лайков пуста");
    } else {
        console.log("Очередь обрабатывает задачи");
    }
}

// Функция добавления likeRecord в очередь с начальным количеством попыток
async function reAddToLikeQueueWithTimeout(likeRecord, retries) {
    const db3 = getDb3();
    const idString = likeRecord._id.toString();
    if (retries < PROXY_RETRY_LIMIT) {
        await delay(180000);
        likeQueue.unshift({ likeRecord, retries: retries + 1 });
        console.log(`likeId ${likeRecord._id} добавлен обратно в очередь после задержки.`);
    } else {
        await totalActiveTasks--;
        await likesCount['productlikes']--;
        console.error(`Максимальное количество попыток для лайка likeId ${likeRecord._id} достигнуто.`);

        try {
            const record = await db3.collection('productlikes').findOne({ _id: new ObjectId(idString) });
            let newDate;
            if (record.schedule && record.schedule.length > 0) {
                const lastDate = new Date(record.schedule[record.schedule.length - 1]);
                newDate = new Date(lastDate.getTime() + MINIMUM_INTERVAL_PRODUCTLIKES);
            } else {
                newDate = await getCurrentDateInMoscow();
            }

            await db3.collection('productlikes').updateOne(
                { _id: new ObjectId(idString) },
                { $push: { schedule: newDate } }
            );
        } catch (error) {
            console.error(`Ошибка при обновлении расписания для likeId ${idString}:`, error);
            await sendErrorToTelegram(`Ошибка при обновлении расписания для likeId ${idString}: ${error.message}`, 'reAddToLikeQueueNoAdd');
        }
    }
}

// Функция для повторного добавления likeRecord в очередь с обновленным количеством попыток
async function reAddToLikeQueue(likeRecord, retries) {
    const db3 = getDb3();
    const idString = likeRecord._id.toString();
    if (retries < RETRY_LIMIT) {
        likeQueue.unshift({ likeRecord, retries: retries + 1 });
    } else {
        await totalActiveTasks--;
        await likesCount['productlikes']--;
        console.error(`Максимальное количество попыток для лайка likeId ${likeRecord._id} достигнуто.`);

        try {
            const record = await db3.collection('productlikes').findOne({ _id: new ObjectId(idString) });
            let newDate;
            if (record.schedule && record.schedule.length > 0) {
                const lastDate = new Date(record.schedule[record.schedule.length - 1]);
                newDate = new Date(lastDate.getTime() + MINIMUM_INTERVAL_PRODUCTLIKES);
            } else {
                newDate = await getCurrentDateInMoscow();
            }

            await db3.collection('productlikes').updateOne(
                { _id: new ObjectId(idString) },
                { $push: { schedule: newDate } }
            );
        } catch (error) {
            console.error(`Ошибка при обновлении расписания для likeId ${idString}:`, error);
            await sendErrorToTelegram(`Ошибка при обновлении расписания для likeId ${idString}: ${error.message}`, 'reAddToLikeQueueNoAdd');
        }
    }
}

// Функция для повторного добавления likeRecord в очередь без обновления количества попыток
async function reAddToLikeQueueNoAdd(likeRecord, retries) {
    const db3 = getDb3();
    const idString = likeRecord._id.toString();
    if (retries < READD_RETRY_LIMIT) {
        likeQueue.unshift({ likeRecord, retries: retries + 1 });
    } else {
        await totalActiveTasks--;
        await likesCount['productlikes']--;
        console.error(`Максимальное количество попыток для лайка likeId ${likeRecord._id} достигнуто.`);

        try {
            const record = await db3.collection('productlikes').findOne({ _id: new ObjectId(idString) });
            let newDate;
            if (record.schedule && record.schedule.length > 0) {
                const lastDate = new Date(record.schedule[record.schedule.length - 1]);
                newDate = new Date(lastDate.getTime() + MINIMUM_INTERVAL_PRODUCTLIKES);
            } else {
                newDate = await getCurrentDateInMoscow();
            }

            await db3.collection('productlikes').updateOne(
                { _id: new ObjectId(idString) },
                { $push: { schedule: newDate } }
            );
        } catch (error) {
            console.error(`Ошибка при обновлении расписания для likeId ${idString}:`, error);
            await sendErrorToTelegram(`Ошибка при обновлении расписания для likeId ${idString}: ${error.message}`, 'reAddToLikeQueueNoAdd');
        }
    }
}

// Функция уменьшения очереди определенного типа лайков
const decrementLikeCount = async (type) => {
    // Проверяем, что тип лайка существует в массиве и больше нуля
    if (likesCount[type] !== undefined && likesCount[type] > 0) {
        likesCount[type]--;
        return likesCount;
    } else {
        console.warn(`Попытка умеьшить likesCount[${type}] невозможна, значение уже 0.`);
        return false;
    }
}

// Функция обработки лайков брендов и товаров
async function processBrandAndProductLike(task) {
    const likeRecord = task.likeRecord;
    const db = await getDb();
    const db2 = await getDb2();
    const db3 = await getDb3();
    const idString = likeRecord._id.toString();

    try {
        console.log('Обработка', idString);

        const like = await db3.collection('productlikes').findOne({ _id: new ObjectId(idString) });
        console.log('like', like);
        if (!like) {
            console.error(`Не найдена запись для likeId ${idString} в базе данных.`);

            await likesCount['productlikes']--;
            await totalActiveTasks--;
            return;
        }

        // const user = await db2.collection('users').findOne({ _id: like.user });
        const user = await db3.collection('users').findOne({ _id: like.user });
        if (!user) {
            console.error(`Не найден user для likeId ${idString} в базе данных.`);

            await likesCount['productlikes']--;
            await totalActiveTasks--;
            return;
        }

        const costForAllActions = (like.amount - like.progress) * PRICE_PER_BRANDPRODUCT_LIKE;
        // console.log('costForAllActions', costForAllActions);
        const hasSufficientBalance = user.balance >= costForAllActions;
        // console.log('user.balance', user.balance);
        // console.log('hasSufficientBalance', hasSufficientBalance);

        if (!hasSufficientBalance) {
            console.error(`У юзера с ID ${like.user.toString()} не достаточно средств на балансе для выполнения действий.`);
            await sendErrorToTelegram(`У юзера с ID ${like.user.toString()} не достаточно средств на балансе для выполнения действий.`, 'processLikeQueue');

            await db3.collection('productlikes').updateOne(
                { _id: new ObjectId(idString) },
                { $set: { status: 'nofunds' } }
            );

            await likesCount['productlikes']--;
            await totalActiveTasks--;
            return;
        }

        let remainingLikes = like.amount - like.progress;

        if (remainingLikes <= 0) {
            if (like.endedDate === null || like.status === 'work') {
                const updateResult = await db3.collection('productlikes').updateOne(
                    { _id: new ObjectId(idString) },
                    {
                        $set: {
                            status: 'completed',
                            endedDate: await getCurrentDateInMoscow()
                        }
                    }
                );

                if (updateResult.modifiedCount !== 1) {
                    console.warn(`Не удалось установить статус 'completed' для likeId ${idString}`);
                } else {
                    console.log(`Задача на лайк с likeId ${idString} завершена.`);
                }
            }

            await likesCount['productlikes']--;
            await totalActiveTasks--;

            console.warn(`Задача с likeId ${idString} уже получила все необходимые лайки.`);
            // await sendErrorToTelegram(`Задача с likeId ${idString} уже получила все необходимые лайки/дизлайки.`, 'processCartLike');
            return;
        }
        if (likesCount['productlikes'] < MAX_TOTAL_ACTIVE_TASKS && totalActiveTasks < MAX_TOTAL_ACTIVE_TASKS) {
            // const user = await db2.collection('users').findOne({ _id: like.user });
            const user = await db3.collection('users').findOne({ _id: like.user });

            const balanceRequiredForOneAction = PRICE_PER_BRANDPRODUCT_LIKE;
            if (user.balance < balanceRequiredForOneAction) {
                console.error(`У юзера с ID ${like.user.toString()} недостаточно средств на балансе для выполнения следующего лайка.`);

                await db3.collection('productlikes').updateOne(
                    { _id: new ObjectId(idString) },
                    { $set: { status: 'nofunds' } }
                );

                await sendErrorToTelegram(`У юзера с ID ${like.user.toString()} недостаточно средств на балансе для выполнения следующего лайка.`, 'processBrandAndProductLike');

                await likesCount['productlikes']--;
                await totalActiveTasks--;

                return;
            }

            let proxy;
            let accountId;
            let phoneNumber;
            let handler;

            console.log('Получаем прокси');
            proxy = await getProxyWithRetries();
            const accountInfo = await getRandomPhoneNumberWithRetries(idString, 'productlikes');
            accountId = accountInfo.id;
            phoneNumber = accountInfo.number;

            switch (like.type) {
                case 'brand':
                    handler = likeBrandHandler;
                    break;
                case 'product':
                    handler = likeProductHandler;
                    break;
                default:
                    throw new Error(`Неизвестный тип лайка: ${like.type}`);
            }

            const outcome = await handler(like, proxy, phoneNumber);
            if (outcome === 'SUCCESS') {
                console.log('Отправили лайк на обработку:', like);

                const result = await db3.collection('productlikes').updateOne(
                    { _id: new ObjectId(idString) },
                    {
                        $inc: { progress: 1 },
                        $push: { accountsUsed: accountId }
                    }
                );

                if (result.modifiedCount !== 1) {
                    throw new Error(`Не удалось обновить прогресс для likeId ${idString}`);
                }

                const paymentTask = {
                    user: like.user,
                    status: 'created',
                    type: 'productlikes',
                    taskId: like._id,
                    createdDate: await getCurrentDateInMoscow(),
                    sum: PRICE_PER_BRANDPRODUCT_LIKE
                };

                try {
                    const insertResult = await db2.collection('Task').insertOne(paymentTask);
                    if (insertResult.acknowledged !== true || insertResult.insertedId == null) {
                        await sendErrorToTelegram('Не удалось вставить новый Task на списание баланса.');
                        throw new Error('Не удалось вставить новый Task на списание баланса.');
                    }
                    const paymentHistoryRecord = {
                        user: like.user,
                        summ: PRICE_PER_BRANDPRODUCT_LIKE,
                        typeoperations: 'Расход',
                        basisoperation: `Лайки ${like._id.toString()}`,
                        dataoperation: await getCurrentDateInMoscow(),
                        comment: '',
                        type: like.type
                    };

                    const insertPaymentHistoryResult = await db3.collection('paymenthistories').insertOne(paymentHistoryRecord);
                    if (insertPaymentHistoryResult.acknowledged !== true || insertPaymentHistoryResult.insertedId == null) {
                        await sendErrorToTelegram('Не удалось записать историю операций в коллекцию paymenthistories.');
                        throw new Error('Не удалось записать историю операций в коллекцию paymenthistories.');
                    }

                } catch (error) {
                    console.error(`Ошибка при добавлении записей в коллекции Task и/или paymenthistories: ${error.message}`);
                    await sendErrorToTelegram(`Ошибка при добавлении записей для пользователя с ID ${like.user.toString()} в коллекции Task и/или paymenthistories: ${error.message}`, 'processLikeQueue');
                    throw error;
                }

                console.log(`Лайк для likeId ${idString} успешно обработан`);

                await likesCount['productlikes']--;
                await totalActiveTasks--;

                let updatedLike = await db3.collection('productlikes').findOne({ _id: new ObjectId(idString) });
                if (!updatedLike) {
                    throw new Error(`Не найдена обновленная запись для likeId ${idString} после операции лайка.`);
                }

                let updatedRemainingLikes = updatedLike.amount - updatedLike.progress;

                if (updatedRemainingLikes == 0) {
                    const updateResult = await db3.collection('productlikes').updateOne(
                        { _id: new ObjectId(idString) },
                        {
                            $set: {
                                status: 'completed',
                                endedDate: await getCurrentDateInMoscow()
                            }
                        }
                    );

                    if (updateResult.modifiedCount !== 1) {
                        console.warn(`Не удалось установить статус 'completed' для likeId ${idString}`);
                        await sendErrorToTelegram(`Не удалось установить статус 'completed' для likeId ${idString}`, 'processLikeQueue');
                    } else {
                        console.log(`Задача на лайк с likeId ${idString} завершена.`);
                    }
                }
            } else {
                if (outcome === 'ALREADY_LIKED') {
                    console.warn(`Бренд или продукт уже был отмечен "лайком" для номера: ${phoneNumber}`);
                    await db3.collection('productlikes').updateOne(
                        { _id: new ObjectId(idString) },
                        { $push: { accountsUsed: accountId } }
                    );
                    await reAddToLikeQueueNoAdd(likeRecord, task.retries);
                } else {
                    console.error('Ошибка при отправке лайка:', outcome);
                    await reAddToLikeQueue(likeRecord, task.retries);
                }
            }

            // Возвращаем аккаунт и прокси обратно в статус 'free'
            if (phoneNumber) {
                await db.collection('accounts').updateOne({ number: phoneNumber }, { $set: { status: 'used' } });
            }

            if (proxy) {
                const isProxyWorking = await checkProxy(proxy);
                const updateData = isProxyWorking ? { status: 'free', lastUsedIP: isProxyWorking } : { status: 'free' };
                await db.collection('proxies').updateOne({ proxy: proxy }, { $set: updateData });
            }
        }

    } catch (error) {
        const errorMessage = `Ошибка при обработке likeId ${idString}: ${error.message}`;
        console.error(errorMessage);
        await sendErrorToTelegram(errorMessage, 'processLikeQueue');
        throw error;
    }
}