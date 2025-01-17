const { SQSClient, SendMessageBatchCommand } = require('@aws-sdk/client-sqs');
const { CloudWatchClient, GetDashboardCommand, PutDashboardCommand } = require('@aws-sdk/client-cloudwatch');
const sqs = new SQSClient();
const cloudWatch = new CloudWatchClient();
const distributionWidgetTitle = 'Runs by Business Process';
const failedAssertionWidgetTitle = 'Failed Assertions (avg)';

exports.handler = async (event) => {
  const distributions = exports.getValidDistributions(event.distributions);
  if (!distributions.length) {
    console.error('No valid collections were provided.');
    return;
  }

  let distributionTotal = 0;
  distributions.map(d => distributionTotal += d.percentage);
  if (distributionTotal != 100) {
    console.error('Provided collection distributions do not equal 100.');
    return;
  }

  const events = exports.createLoadTestEvents(event.count ?? 1000, distributions);

  await exports.queueEvents(events);

  if (event.options?.updateDashboardWithDistributionNames) {
    await exports.updateDashboardToIncludeDistributions(event.distributions);
  }

  return {
    dashboard: `https://${process.env.AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${process.env.AWS_REGION}#dashboards:name=${process.env.DASHBOARD_NAME}`,
    queuedEvents: event.count ?? 1000
  };
};

exports.getValidDistributions = (distributions) => {
  const validDistributions = [];
  distributions.map(d => {
    if ((d.postmanCollectionId || d.postmanEnvironmentId) && !d.postmanApiKey) {
      console.warn(`${d.name} uses a Postman collection or environment but does not have an API key provided.`);
    }
    if (!d.postmanCollectionId && !d.s3CollectionPath) {
      console.warn(`${d.name} does not have a collection provided.`);
    }

    if (!d.percentage) {
      console.log(`${d.name} was not given a distribution percentage, so it will be defaulted to 100%.`);
      d.percentage = 100;
    }

    validDistributions.push(d);
  });

  return validDistributions;
};

exports.createLoadTestEvents = (count, distributions) => {
  const events = [];
  distributions.map(distribution => {
    const eventCount = Math.ceil(count * distribution.percentage / 100);
    for (let i = 0; i < eventCount; i++) {
      events.push({
        ...distribution.name && { name: distribution.name },
        ...distribution.s3CollectionPath && { s3CollectionPath: distribution.s3CollectionPath },
        ...distribution.postmanApiKey && { postmanApiKey: distribution.postmanApiKey },
        ...distribution.postmanCollectionId && { postmanCollectionId: distribution.postmanCollectionId },
        ...distribution.s3EnvironmentPath && { s3EnvironmentPath: distribution.s3EnvironmentPath },
        ...distribution.postmanEnvironmentId && { postmanEnvironmentId: distribution.postmanEnvironmentId }
      })
    }
  });

  return events;
};

exports.createMessageBatchCommands = (events) => {
  const commands = [];
  while (events.length) {
    const batch = events.splice(0, 10);
    commands.push(new SendMessageBatchCommand({
      Entries: batch.map((item, index) => {
        return {
          MessageBody: JSON.stringify(item),
          Id: `${index}`
        }
      }),
      QueueUrl: process.env.QUEUE_URL
    }));
  }

  return commands;
};

exports.queueEvents = async (events) => {
  const commands = exports.createMessageBatchCommands(events);
  await Promise.all(commands.map(async (command) => {
    await sqs.send(command);
  }));
};

exports.updateDashboardToIncludeDistributions = async (distributions) => {
  let dashboard = await exports.getLoadTestDashboard();
  if (!dashboard) return;

  dashboard = exports.updateDashboardWithDistributionNames(dashboard, distributions);
  await cloudWatch.send(new PutDashboardCommand({ DashboardName: process.env.DASHBOARD_NAME, DashboardBody: JSON.stringify(dashboard) }));
};

exports.getLoadTestDashboard = async () => {
  const response = await cloudWatch.send(new GetDashboardCommand({ DashboardName: process.env.DASHBOARD_NAME }));
  if (response?.DashboardBody) {
    return JSON.parse(response.DashboardBody);
  }
};

exports.updateDashboardWithDistributionNames = (dashboard, distributions) => {
  const distributionWidget = exports.getDistributionWidget(dashboard);
  const failedAssertionWidget = exports.getFailedAssertionWidget(dashboard);

  distributions.map(d => {
    if (d.name && !distributionWidget.properties.metrics.some(m => m.includes(d.name))) {
      distributionWidget.properties.metrics.push(['load-test', 'runs', 'Collection', d.name]);
    }

    if(d.name && !failedAssertionWidget.properties.metrics.some(m => m.includes(d.name))) {
      failedAssertionWidget.properties.metrics.push(['load-test', 'failed-assertions', 'Collection', d.name]);
    }
  });

  return dashboard;
};

exports.getFailedAssertionWidget = (dashboard) => {
  let failedAssertionWidget = dashboard.widgets.find(w => w.properties.title == failedAssertionWidgetTitle);
  if (!failedAssertionWidget) {
    failedAssertionWidget = {
      type: "metric",
      x: 10,
      y: 0,
      width: 6,
      height: 6,
      properties: {
        metrics: [
          ["load-test", "failed-assertions", "Collection", "Trial Run B"],
          ["...", "Trial Run A"]
        ],
        view: 'timeSeries',
        stacked: true,
        region: process.env.AWS_REGION,
        stat: 'Average',
        period: 300,
        title: failedAssertionWidgetTitle
      }
    };

    dashboard.widgets.push(failedAssertionWidget);
  }

  return failedAssertionWidget;
};

exports.getDistributionWidget = (dashboard) => {
  let distributionWidget = dashboard.widgets.find(w => w.properties.title == distributionWidgetTitle);
  if (!distributionWidget) {
    distributionWidget = {
      height: 6,
      width: 10,
      y: 6,
      x: 0,
      type: 'metric',
      properties: {
        metrics: [],
        view: 'pie',
        region: process.env.AWS_REGION,
        stat: "Sum",
        period: 3600,
        labels: {
          'visible': true
        },
        liveData: true,
        title: distributionWidgetTitle,
        setPeriodToTimeRange: true,
        sparkline: false
      }
    }
    dashboard.widgets.push(distributionWidget);
  }
  return distributionWidget;
};